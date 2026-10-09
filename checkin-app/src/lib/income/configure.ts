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
 * - owners: checkin's budget-owner buckets.
 */
import {
  configureIncome,
  mirrorPayoutStatus,
  mirrorSource,
  quickBooksDepositSource,
  type MirrorBalanceTxn,
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
    return prisma.budgetOwner.findMany({ select: { id: true, name: true, archivedAt: true }, orderBy: { name: "asc" } });
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

export function configureIncomeRuntime(): void {
  configureIncome({
    auth: { getPrincipal },
    org: getOrg,
    mirror: mirrorConfigured() ? payoutMirror : undefined,
    deposits: depositSource(),
    owners,
  });
}
