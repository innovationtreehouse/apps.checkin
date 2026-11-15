// The ports another lane calls to hand income a deposit it expects and read back what became of
// it. The caller calls expectDeposit only after its own record has committed, and again from a
// re-send job for every key depositStatus leaves out; a repeat changes nothing.
import { isBooksMapRole, isRetiredBooksMapRole, type BooksMapRole, type RetiredBooksMapRole } from "@checkin/quickbooks";
import { ServiceError } from "@checkin/component-kit";
import { db } from "../db";
import type { PayoutReconciliation } from "../generated/prisma/client";
import { assertOrg } from "../runtime";
import { RECON_KIND, RECON_ORIGIN, RECON_RESOLUTION, RECON_STATUS, audit, isClaimed, lockReconciliation } from "./reconcile";
import { DEPOSIT_SOURCE, type DepositSourceName } from "./sources";

/**
 * One line of an expected deposit: the QuickBooks account it books to and a budget bucket (null for
 * organization level). A line stored before lanes named accounts, or a fee line stored before fees
 * reduced income, carries only a retired role, and goes to finance.
 */
export type ExpectedDepositLine = {
  accountId?: string;
  role?: RetiredBooksMapRole;
  budgetOwnerId: number | null;
  amountCents: number;
  description?: string;
};

/** The deposit a lane expects to land in the bank. Income resolves its bank role and buckets through the books map when it posts. */
export type ExpectedDeposit = {
  /** YYYY-MM-DD. */
  txnDate: string;
  netCents: number;
  bankRole: BooksMapRole;
  lines: ExpectedDepositLine[];
  memo?: string;
};

/** What expectDeposit did: a new row, an unposted row brought up to date, nothing to change, or a row past changing. */
export type ExpectOutcome = "recorded" | "updated" | "unchanged" | "frozen";

export type DepositStatus =
  | { state: "waiting" }
  | { state: "booked" | "matched"; depositId: string; txnDate: string | null; totalCents: number | null }
  | { state: "with_finance"; kind: string | null; note: string | null }
  | { state: "drifted"; note: string | null }
  | { state: "dismissed"; reason: string | null };

const DAY = /^\d{4}-\d{2}-\d{2}$/;

const QB_ID = /^\d+$/;

/** The expected deposit, checked; throws a 400 naming the first problem. */
export function parseExpected(raw: ExpectedDeposit): ExpectedDeposit {
  return checkExpected(raw, true);
}

/** `fresh` is a new hand-over; a stored row may carry a retired-role line from before lanes named accounts. */
function checkExpected(raw: ExpectedDeposit, fresh: boolean): ExpectedDeposit {
  const bad = (msg: string) => new ServiceError(400, msg);
  if (!DAY.test(raw.txnDate) || Number.isNaN(Date.parse(`${raw.txnDate}T00:00:00Z`))) throw bad("txnDate must be YYYY-MM-DD");
  if (!Number.isInteger(raw.netCents) || raw.netCents <= 0) throw bad("netCents must be a positive whole number");
  if (!isBooksMapRole(raw.bankRole)) throw bad(`bankRole "${raw.bankRole}" is not a books-map role`);
  if (!raw.lines.length) throw bad("an expected deposit needs at least one line");
  for (const l of raw.lines) {
    if (l.accountId !== undefined && l.role !== undefined) throw bad("a line names an account or a role, not both");
    if (l.accountId !== undefined && !QB_ID.test(l.accountId)) throw bad("line accountId must be a QuickBooks id (digits only)");
    if (l.role !== undefined && !isRetiredBooksMapRole(l.role)) throw bad(`line role "${l.role}" is not a retired books-map role`);
    if (l.accountId === undefined && (fresh || l.role === undefined)) throw bad("a line needs its QuickBooks account id");
    if (!Number.isInteger(l.amountCents)) throw bad("line amountCents must be a whole number");
    if (l.budgetOwnerId !== null && (!Number.isInteger(l.budgetOwnerId) || l.budgetOwnerId <= 0)) throw bad("line budgetOwnerId must be a positive integer or null");
  }
  const sum = raw.lines.reduce((s, l) => s + l.amountCents, 0);
  if (sum !== raw.netCents) throw bad(`lines sum to ${sum}, netCents is ${raw.netCents}`);
  return {
    txnDate: raw.txnDate,
    netCents: raw.netCents,
    bankRole: raw.bankRole,
    lines: raw.lines.map((l) => ({
      ...(l.accountId !== undefined ? { accountId: l.accountId } : { role: l.role }),
      budgetOwnerId: l.budgetOwnerId,
      amountCents: l.amountCents,
      ...(l.description ? { description: l.description } : {}),
    })),
    ...(raw.memo ? { memo: raw.memo } : {}),
  };
}

/** A row's expected deposit, rebuilt in parseExpected's key order (JSONB keeps its own). Null on a Shopify row. */
export function expectedOf(row: Pick<PayoutReconciliation, "expected">): ExpectedDeposit | null {
  return row.expected === null ? null : checkExpected(row.expected as ExpectedDeposit, false);
}

/** Whether nothing in QuickBooks can yet depend on the row: no deposit held, no create attempted, no post running, not settled. */
const unposted = (r: PayoutReconciliation) =>
  r.depositId === null && r.qbCreateAttemptedAt === null && !isClaimed(r) && r.status !== RECON_STATUS.RESOLVED;

/**
 * Record that `source` expects the deposit `sourceKey` to land. A new key becomes a WAITING row
 * the next drain matches or books. A repeat with the same deposit changes nothing; a changed
 * deposit updates the row while nothing in QuickBooks can depend on it, and is refused silently
 * ("frozen") after.
 */
export async function expectDeposit(orgId: string, source: typeof DEPOSIT_SOURCE.BENEVITY, sourceKey: string, raw: ExpectedDeposit): Promise<ExpectOutcome> {
  await assertOrg(orgId);
  if (source !== DEPOSIT_SOURCE.BENEVITY) throw new ServiceError(400, `income takes no expected deposits from "${source}"`);
  const key = sourceKey.trim();
  if (!key) throw new ServiceError(400, "sourceKey is required");
  const expected = parseExpected(raw);
  return db.$transaction(async (tx) => {
    await lockReconciliation(tx, orgId, true);
    const current = await tx.payoutReconciliation.findUnique({ where: { orgId_source_payoutGid: { orgId, source, payoutGid: key } } });
    if (!current) {
      const saved = await tx.payoutReconciliation.create({
        data: { orgId, source, payoutGid: key, payoutDate: expected.txnDate, payoutNetCents: expected.netCents, status: RECON_STATUS.WAITING, expected: { ...expected } },
      });
      await audit(tx, orgId, "reconciliation.expected", null, saved);
      return "recorded";
    }
    if (JSON.stringify(expectedOf(current)) === JSON.stringify(expected)) return "unchanged";
    if (!unposted(current)) return "frozen";
    const saved = await tx.payoutReconciliation.update({
      where: { id: current.id },
      data: { payoutDate: expected.txnDate, payoutNetCents: expected.netCents, expected: { ...expected } },
    });
    await audit(tx, orgId, "reconciliation.expected_updated", current, saved);
    return "updated";
  });
}

/** What became of one row, as the lane that handed it over sees it. */
export function statusOf(r: PayoutReconciliation): DepositStatus {
  if (r.status === RECON_STATUS.WAITING) return { state: "waiting" };
  if (r.status === RECON_STATUS.OPEN) {
    return r.kind === RECON_KIND.DRIFT ? { state: "drifted", note: r.qbNote ?? r.reason } : { state: "with_finance", kind: r.kind, note: r.qbNote ?? r.reason };
  }
  if (r.resolution === RECON_RESOLUTION.DISMISSED) return { state: "dismissed", reason: r.reason };
  if (!r.depositId) return { state: "with_finance", kind: r.kind, note: r.qbNote ?? r.reason };
  return {
    state: r.origin === RECON_ORIGIN.CREATED ? "booked" : "matched",
    depositId: r.depositId,
    txnDate: r.depositTxnDate,
    totalCents: r.depositTotalCents,
  };
}

/** Per key, what became of each deposit `source` handed over. A key income has no row for is absent: hand it over again. */
export async function depositStatus(orgId: string, source: DepositSourceName, sourceKeys: string[]): Promise<Record<string, DepositStatus>> {
  await assertOrg(orgId);
  const rows = await db.payoutReconciliation.findMany({ where: { orgId, source, payoutGid: { in: sourceKeys } } });
  return Object.fromEntries(rows.map((r) => [r.payoutGid, statusOf(r)]));
}
