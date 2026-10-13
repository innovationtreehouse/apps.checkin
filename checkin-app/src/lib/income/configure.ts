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
 * - deposits: QuickBooks deposit reads over checkin's one token source, bound
 *   only where QBO_REALM_ID is set. Without a published token every read
 *   throws, so a run fails and writes nothing.
 * - bankAccountId: the QuickBooks bank account payouts land in, from
 *   QBO_INCOME_BANK_ACCOUNT_ID. Unset, a run answers "unbound" and matches
 *   nothing.
 * - owners: checkin's budget-owner buckets.
 * - alerts: a drain that stops at a cap emails finance (the board when no one
 *   holds FINANCE), so the payouts it left waiting reach a person.
 */
import {
  configureIncome,
  mirrorPayoutStatus,
  mirrorSource,
  quickBooksDepositSource,
  type MirrorBalanceTxn,
  type IncomeAlerts,
  type MirrorPayout,
  type OwnerDirectory,
  type PayoutMirror,
  type QbDepositSource,
} from "@inventory/income";
import { getOrg, getPrincipal } from "@/lib/catalog/configure";
import { qboAccessTokenSource, qboRealm } from "@/lib/quickbooks/connection";
import {
  incomeItemsSeen,
  incomeOrderLines,
  incomePaidPayoutsSince,
  incomePayout,
  incomePayoutTransactions,
  isConfigured as mirrorConfigured,
  type IncomeMirrorPayoutRow,
} from "@/lib/shopifyRead/client";
import { config } from "@/lib/config";
import { logger } from "@/lib/logger";

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
};

function depositSource(): QbDepositSource | undefined {
  const realm = qboRealm();
  if (!realm) return undefined;
  try {
    return quickBooksDepositSource(qboAccessTokenSource(), realm);
  } catch (err) {
    logger.error("[income] QuickBooks realm rejected; deposit reads stay unbound:", err);
    return undefined;
  }
}

export function configureRuntime(): void {
  configureIncome({
    auth: { getPrincipal },
    org: getOrg,
    mirror: mirrorConfigured() ? payoutMirror : undefined,
    deposits: depositSource(),
    bankAccountId: process.env.QBO_INCOME_BANK_ACCOUNT_ID || undefined,
    owners,
    alerts,
  });
}
