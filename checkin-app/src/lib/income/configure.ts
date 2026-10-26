/**
 * Wire the income library into checkin, called once at server boot from
 * instrumentation.ts. Binding touches no database and no network: every port
 * reads lazily inside a request (or the daily cron).
 *
 * - auth/org: the catalog's principal and lazy Org-registry accessor, so every
 *   library stamps the same person and org ids.
 * - mirror: the s-read Shopify mirror, bound only where it is wired. Unbound,
 *   a run answers "unbound" instead of reading an empty mirror and reopening
 *   every settled payout as drift.
 * - deposits: QuickBooks deposit reads through checkin's one guarded client,
 *   bound only where QBO_REALM_ID is set. While the guard keeps QuickBooks off,
 *   every read throws, so a run fails and writes nothing.
 * - bankAccountId / benevityBankAccountId: the environment's bank accounts for
 *   Shopify payouts (QBO_INCOME_BANK_ACCOUNT_ID) and Benevity disbursements
 *   (QBO_DONATION_BANK_ACCOUNT_ID), used where the books map sets no bank role.
 *   With neither for a source, its deposits are not matched.
 * - posting: deposit creation through a client built here by checkin's guarded
 *   builder, bound where QBO_REALM_ID is set and the guard admits the company.
 *   The four QBO_INCOME_*_ACCOUNT_ID deposit-line accounts, when all set, stand
 *   in for Shopify roles the books map leaves unset; a row whose roles neither
 *   sets is skipped. Unbound, the drain and the orphan sweep answer "unbound".
 *   Shopify creation stays gated until INCOME_MIRROR_NEWEST_WINS is "true".
 * - owners: checkin's budget-owner buckets.
 * - booksMap: finance's books map (role -> QuickBooks account, bucket -> Class),
 *   which income resolves every deposit's accounts and Classes through.
 * - classes: the active QuickBooks Classes, bound only where QBO_REALM_ID is
 *   set. Unbound or unreachable, no item can be assigned to a bucket.
 * - otherLaneClaims: deposits bulk donation holds, kept out of income's matching.
 * - alerts: a drain that stops at a cap emails finance (the board when no one
 *   holds FINANCE), so the payouts it left waiting reach a person. A bucket
 *   that becomes unusable emails finance once, so the payouts it holds reach a
 *   person. An orphan sweep that cannot read every new deposit emails finance.
 */
import {
  configureIncome,
  mirrorPayoutStatus,
  mirrorSource,
  toQbDeposit,
  type MirrorBalanceTxn,
  type IncomeAlerts,
  type IncomePosting,
  type IncomeQbAccounts,
  type MirrorPayout,
  type OwnerDirectory,
  type PayoutMirror,
  type QbClassSource,
  type QbDepositSource,
} from "@checkin/income";
import { getOrg, getPrincipal } from "@/lib/catalog/configure";
import {
  incomeItemsSeen,
  incomeOrderLines,
  incomePaidPayoutsSince,
  incomePayout,
  incomePayoutTransactions,
  isConfigured as mirrorConfigured,
  type IncomeMirrorPayoutRow,
} from "@/lib/shopifyRead/client";
import { buildQuickBooks, getQuickBooks } from "@/lib/quickbooks/client";
import { config } from "@/lib/config";
import type { BooksMap } from "@checkin/quickbooks";

function toPayout(row: IncomeMirrorPayoutRow): MirrorPayout | null {
  const source = mirrorSource(row.source);
  if (!source) return null;
  return { ...row, status: mirrorPayoutStatus(row.status), source };
}

const payoutMirror: PayoutMirror = {
  async paidPayoutsSince(from) {
    return (await incomePaidPayoutsSince(from)).flatMap((r) => toPayout(r) ?? []);
  },
  async payout(gid) {
    const row = await incomePayout(gid);
    return row ? toPayout(row) : null;
  },
  async transactions(payoutGid) {
    return (await incomePayoutTransactions(payoutGid)).flatMap((r): MirrorBalanceTxn[] => {
      const source = mirrorSource(r.source);
      return source ? [{ ...r, source }] : [];
    });
  },
  async orderLines(orderGids) {
    return (await incomeOrderLines(orderGids)).map((l) => ({ ...l, title: l.title ?? "" }));
  },
  async itemsSeen() {
    return (await incomeItemsSeen()).map((i) => ({ ...i, title: i.title ?? "" }));
  },
};

const owners: OwnerDirectory = {
  async list() {
    const { default: prisma } = await import("@/lib/prisma");
    return prisma.budgetOwner.findMany({ select: { id: true, name: true, archivedAt: true, quickBooksClassId: true }, orderBy: { name: "asc" } });
  },
};

const booksMap: BooksMap = {
  async accounts() {
    return (await import("@/lib/finance/booksMap")).booksMap.accounts();
  },
  async classes() {
    return (await import("@/lib/finance/booksMap")).booksMap.classes();
  },
};

const alerts: IncomeAlerts = {
  async postCapReached({ cap, created, remaining }) {
    const { notifyFinanceAlert } = await import("@/lib/emailRecipients");
    const limit = cap === "count" ? "number of deposits" : "dollar total";
    await notifyFinanceAlert(
      "Income: deposit creation stopped at its per-run cap",
      `<p>Today's income run created ${created} QuickBooks deposit(s) and stopped at its per-run ${limit} cap; ${remaining} payout(s) are still waiting. Nothing else was posted. <a href="${config.baseUrl()}/income/reconciliation">Open income reconciliation</a></p>`,
      "Income cap alert failed:",
    );
  },
  async bucketUnusable({ budgetOwnerId, bucketName, issue, itemCount }) {
    const [{ notifyFinanceAlert }, { escapeHtml }] = await Promise.all([import("@/lib/emailRecipients"), import("@/lib/email-templates/base")]);
    const name = escapeHtml(bucketName ?? `#${budgetOwnerId}`);
    await notifyFinanceAlert(
      "Income: a budget-owner bucket can't take sales",
      `<p>The budget-owner bucket ${name} ${escapeHtml(issue)}. ${itemCount} store item(s) are assigned to it, and payouts with their sales wait until you restore the bucket or its Class, or reassign the items. <a href="${config.baseUrl()}/income/items">Open income items</a></p>`,
      "Income bucket alert failed:",
    );
  },
  async sweepIncomplete({ since }) {
    const { notifyFinanceAlert } = await import("@/lib/emailRecipients");
    await notifyFinanceAlert(
      "Income: the daily check for stray QuickBooks deposits could not see them all",
      `<p>QuickBooks returned more deposits created since ${since.toISOString().slice(0, 10)} than the daily check reads at once, so a deposit the app created may sit in QuickBooks unlinked. Check recent deposits that carry a checkin key in their memo. <a href="${config.baseUrl()}/income/reconciliation">Open income reconciliation</a></p>`,
      "Income sweep alert failed:",
    );
  },
};


function depositSource(): QbDepositSource | undefined {
  if (!process.env.QBO_REALM_ID) return undefined;
  return {
    async depositsBetween(from, to) {
      const qb = await getQuickBooks();
      if (!qb) throw new Error("QuickBooks is off");
      return (await qb.depositsBetween(from, to)).map(toQbDeposit);
    },
  };
}

function classSource(): QbClassSource | undefined {
  if (!process.env.QBO_REALM_ID) return undefined;
  return {
    async activeClassIds() {
      const qb = await getQuickBooks();
      if (!qb) throw new Error("QuickBooks is off");
      return (await qb.classes()).filter((c) => c.Active !== false).map((c) => c.Id);
    },
  };
}

function qbAccounts(): IncomeQbAccounts | undefined {
  const income = process.env.QBO_INCOME_INCOME_ACCOUNT_ID;
  const charge_remainder = process.env.QBO_INCOME_CHARGE_REMAINDER_ACCOUNT_ID;
  const fees = process.env.QBO_INCOME_FEES_ACCOUNT_ID;
  const adjustments = process.env.QBO_INCOME_ADJUSTMENTS_ACCOUNT_ID;
  return income && charge_remainder && fees && adjustments ? { income, charge_remainder, fees, adjustments } : undefined;
}

function posting(): IncomePosting | undefined {
  if (!process.env.QBO_REALM_ID) return undefined;
  const client = buildQuickBooks();
  if (!client) return undefined;
  return { client, accounts: qbAccounts(), mirrorNewestWins: process.env.INCOME_MIRROR_NEWEST_WINS === "true" };
}

async function donationClaimedDepositIds(orgId: string): Promise<string[]> {
  return (await import("@checkin/bulk-donation")).donationClaimedDepositIds(orgId);
}

export function configureRuntime(): void {
  configureIncome({
    auth: { getPrincipal },
    org: getOrg,
    mirror: mirrorConfigured() ? payoutMirror : undefined,
    deposits: depositSource(),
    bankAccountId: process.env.QBO_INCOME_BANK_ACCOUNT_ID || undefined,
    benevityBankAccountId: process.env.QBO_DONATION_BANK_ACCOUNT_ID || undefined,
    posting: posting(),
    owners,
    booksMap,
    classes: classSource(),
    alerts,
    otherLaneClaims: { claimedDepositIds: donationClaimedDepositIds },
  });
}
