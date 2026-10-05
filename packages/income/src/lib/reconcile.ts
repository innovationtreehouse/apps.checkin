import { db } from "../db";
import type { PayoutReconciliation } from "../generated/prisma/client";
import type { MirrorPayout, PayoutMirror, QbDeposit } from "../contract";
import { getIncomeConfig, isoDay } from "../runtime";
import { recordAudit, type TxClient } from "./audit";

export const RECON_STATUS = { OPEN: "OPEN", MATCHED: "MATCHED", RESOLVED: "RESOLVED" } as const;
export type ReconStatus = (typeof RECON_STATUS)[keyof typeof RECON_STATUS];

export const RECON_KIND = {
  NO_DEPOSIT: "NO_DEPOSIT",
  AMBIGUOUS_DEPOSIT: "AMBIGUOUS_DEPOSIT",
  TXN_SUM_MISMATCH: "TXN_SUM_MISMATCH",
  DRIFT: "DRIFT",
} as const;
export type ReconKind = (typeof RECON_KIND)[keyof typeof RECON_KIND];

export const RECON_RESOLUTION = { AUTO: "AUTO", MANUAL: "MANUAL", DISMISSED: "DISMISSED" } as const;

export const DEFAULT_WINDOW_DAYS = 7;

/** A paid mirror payout, normalised for matching. */
export interface PayoutFact {
  payoutGid: string;
  payoutDate: string;
  netCents: number;
  sumMismatch: boolean;
}

export type ReconcileResult =
  | { status: "unbound" }
  | { status: "busy" }
  | { status: "ran"; matched: number; opened: number; drifted: number };

export function addDays(day: string, n: number): string {
  return isoDay(new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000));
}

export function windowDays(): number {
  return getIncomeConfig().windowDays ?? DEFAULT_WINDOW_DAYS;
}

/**
 * Serialise every reconciliation write for an org (cron, "run now", finance actions).
 * Returns false when `wait` is off and another holder has it.
 */
export async function lockReconciliation(tx: TxClient, orgId: string, wait: boolean): Promise<boolean> {
  if (wait) {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('income.reconcile'), hashtext(${orgId}))::text`;
    return true;
  }
  const [{ locked }] = await tx.$queryRaw<{ locked: boolean }[]>`
    SELECT pg_try_advisory_xact_lock(hashtext('income.reconcile'), hashtext(${orgId})) AS locked`;
  return locked;
}

async function collectPayouts(mirror: PayoutMirror): Promise<PayoutFact[]> {
  const { reconcileFrom } = getIncomeConfig();
  const facts: PayoutFact[] = [];
  for (const p of await mirror.paidPayoutsSince(reconcileFrom ?? new Date(0))) {
    const txns = await mirror.transactions(p.payoutGid);
    const txnNet = txns.reduce((s, t) => s + t.netCents, 0);
    facts.push({
      payoutGid: p.payoutGid,
      payoutDate: isoDay(p.issuedAt),
      netCents: p.netCents,
      sumMismatch: txnNet !== p.netCents,
    });
  }
  return facts.sort((a, b) => a.payoutDate.localeCompare(b.payoutDate) || a.payoutGid.localeCompare(b.payoutGid));
}

/** Why a settled row must reopen, or null when its payout and deposit still agree with it. */
function driftCause(
  row: PayoutReconciliation,
  payout: MirrorPayout | null,
  deposits: Map<string, QbDeposit>,
): string | null {
  if (!payout) return "payout_missing";
  if (payout.status !== "paid") return `payout_status:${payout.status}`;
  if (payout.netCents !== row.payoutNetCents) return "payout_amount";
  if (!row.depositId) return null;
  const d = deposits.get(row.depositId);
  if (!d) return "deposit_missing";
  if (d.totalCents !== row.depositTotalCents || d.txnDate !== row.depositTxnDate) return "deposit_changed";
  return null;
}

/**
 * Match every paid payout to exactly one QuickBooks deposit, or raise it for finance.
 * Idempotent; a no-op until a deposit source is bound. Reads the ledger only.
 */
export async function runReconcile(orgId: string, now: Date = new Date()): Promise<ReconcileResult> {
  const { deposits: depositSource, mirror } = getIncomeConfig();
  if (!depositSource || !mirror) return { status: "unbound" };

  const window = windowDays();
  const today = isoDay(now);
  const facts = await collectPayouts(mirror);

  // Settled rows are drift-checked against the payout's current state, whether or not it is
  // still paid and inside reconcileFrom. Rows settled after this read are checked next run.
  const settled = await db.payoutReconciliation.findMany({
    where: { orgId, status: { not: RECON_STATUS.OPEN } },
    select: { payoutGid: true, payoutDate: true },
  });
  const settledPayouts = new Map<string, MirrorPayout | null>();
  for (const { payoutGid } of settled) settledPayouts.set(payoutGid, await mirror.payout(payoutGid));

  const earliest = [...facts.map((f) => f.payoutDate), ...settled.map((r) => r.payoutDate)].sort()[0];
  const deposits = earliest ? await depositSource.depositsSince(new Date(`${earliest}T00:00:00Z`)) : [];
  const depositsById = new Map(deposits.map((d) => [d.id, d]));

  return db.$transaction(
    async (tx) => {
      if (!(await lockReconciliation(tx, orgId, false))) return { status: "busy" } as const;

      const result = { status: "ran" as const, matched: 0, opened: 0, drifted: 0 };
      const rows = await tx.payoutReconciliation.findMany({ where: { orgId } });
      const byGid = new Map(rows.map((r) => [r.payoutGid, r]));
      const claimed = new Set(rows.flatMap((r) => (r.depositId ? [r.depositId] : [])));

      // Settled rows whose payout or deposit moved reopen for finance; never re-matched silently.
      for (const row of rows) {
        if (row.status === RECON_STATUS.OPEN || !settledPayouts.has(row.payoutGid)) continue;
        const payout = settledPayouts.get(row.payoutGid) ?? null;
        const cause = driftCause(row, payout, depositsById);
        if (!cause) continue;

        if (row.depositId) claimed.delete(row.depositId);
        const updated = await tx.payoutReconciliation.update({
          where: { id: row.id },
          data: {
            status: RECON_STATUS.OPEN,
            kind: RECON_KIND.DRIFT,
            resolution: null,
            depositId: null,
            depositTxnDate: null,
            depositTotalCents: null,
            payoutNetCents: payout?.netCents ?? row.payoutNetCents,
          },
        });
        byGid.set(row.payoutGid, updated);
        await audit(tx, orgId, "reconciliation.drift", row, updated, { userId: null, reason: cause });
        result.drifted++;
      }

      for (const fact of facts) {
        const row = byGid.get(fact.payoutGid);
        if (row && (row.status !== RECON_STATUS.OPEN || row.kind === RECON_KIND.DRIFT)) continue;

        const candidates = fact.sumMismatch
          ? []
          : deposits.filter(
              (d) =>
                !claimed.has(d.id) &&
                d.totalCents === fact.netCents &&
                d.txnDate >= fact.payoutDate &&
                d.txnDate <= addDays(fact.payoutDate, window),
            );

        if (candidates.length === 1) {
          const d = candidates[0];
          const data = {
            status: RECON_STATUS.MATCHED,
            kind: null,
            resolution: RECON_RESOLUTION.AUTO,
            depositId: d.id,
            depositTxnDate: d.txnDate,
            depositTotalCents: d.totalCents,
            payoutNetCents: fact.netCents,
          };
          const saved = row
            ? await tx.payoutReconciliation.update({ where: { id: row.id }, data })
            : await tx.payoutReconciliation.create({ data: { ...base(orgId, fact), ...data } });
          claimed.add(d.id);
          await audit(tx, orgId, "reconciliation.matched", row ?? null, saved);
          result.matched++;
          continue;
        }

        const windowElapsed = today > addDays(fact.payoutDate, window);
        if (!fact.sumMismatch && !windowElapsed) continue;

        const kind = fact.sumMismatch
          ? RECON_KIND.TXN_SUM_MISMATCH
          : candidates.length === 0
            ? RECON_KIND.NO_DEPOSIT
            : RECON_KIND.AMBIGUOUS_DEPOSIT;
        if (row && row.kind === kind && row.payoutNetCents === fact.netCents) continue;

        const saved = row
          ? await tx.payoutReconciliation.update({
              where: { id: row.id },
              data: { kind, payoutNetCents: fact.netCents },
            })
          : await tx.payoutReconciliation.create({
              data: { ...base(orgId, fact), status: RECON_STATUS.OPEN, kind },
            });
        await audit(tx, orgId, "reconciliation.opened", row ?? null, saved);
        if (!row) result.opened++;
      }

      return result;
    },
    { timeout: 60_000 },
  );
}

function base(orgId: string, fact: PayoutFact) {
  return {
    orgId,
    payoutGid: fact.payoutGid,
    payoutDate: fact.payoutDate,
    payoutNetCents: fact.netCents,
  };
}

export function audit(
  tx: TxClient,
  orgId: string,
  action: string,
  before: PayoutReconciliation | null,
  after: PayoutReconciliation,
  actor: { userId: number | null; username?: string; reason?: string | null; correlationId?: string } = {
    userId: null,
  },
): Promise<void> {
  return recordAudit(tx, {
    orgId,
    actorUserId: actor.userId,
    actorUsername: actor.username,
    action,
    entityType: "payout_reconciliation",
    entityId: after.id,
    before: before ?? undefined,
    after,
    reason: actor.reason,
    correlationId: actor.correlationId,
  });
}
