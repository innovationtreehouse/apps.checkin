import { db, isUniqueConstraintError } from "../db";
import type { QbDeposit } from "../contract";
import { getIncomeConfig } from "../runtime";
import {
  RECON_RESOLUTION,
  RECON_STATUS,
  addDays,
  audit,
  lockReconciliation,
  runReconcile,
  windowDays,
  type ReconStatus,
} from "../lib/reconcile";
import { ServiceError } from "./serviceError";

interface Actor {
  userId: number;
  username?: string;
  correlationId?: string;
}

async function openRow(orgId: string, id: number) {
  const row = await db.payoutReconciliation.findUnique({ where: { id } });
  if (!row || row.orgId !== orgId) throw new ServiceError(404, "Not found");
  return row;
}

/** Unclaimed deposits dated within ±window of the payout, read live from QuickBooks. */
async function liveCandidates(orgId: string, payoutDate: string): Promise<QbDeposit[]> {
  const source = getIncomeConfig().deposits;
  if (!source) throw new ServiceError(503, "QuickBooks is not connected");
  const w = windowDays();
  const from = addDays(payoutDate, -w);
  const to = addDays(payoutDate, w);
  const [deposits, claimed] = await Promise.all([
    source.depositsSince(new Date(`${from}T00:00:00Z`)),
    db.payoutReconciliation.findMany({
      where: { orgId, depositId: { not: null } },
      select: { depositId: true },
    }),
  ]);
  const taken = new Set(claimed.map((c) => c.depositId));
  return deposits.filter((d) => d.txnDate >= from && d.txnDate <= to && !taken.has(d.id));
}

export const reconciliationService = {
  run(orgId: string, now?: Date) {
    return runReconcile(orgId, now);
  },

  list(orgId: string, status?: ReconStatus) {
    return db.payoutReconciliation.findMany({
      where: { orgId, status },
      orderBy: [{ payoutDate: "desc" }, { id: "desc" }],
    });
  },

  count(orgId: string, status?: ReconStatus) {
    return db.payoutReconciliation.count({ where: { orgId, status } });
  },

  async candidates(orgId: string, id: number) {
    const row = await openRow(orgId, id);
    return liveCandidates(orgId, row.payoutDate);
  },

  async matchToDeposit(orgId: string, id: number, depositId: string, actor: Actor) {
    const row = await openRow(orgId, id);
    const deposit = (await liveCandidates(orgId, row.payoutDate)).find((d) => d.id === depositId);
    if (!deposit) throw new ServiceError(422, "Deposit is not an unclaimed candidate for this payout");

    try {
      return await db.$transaction(async (tx) => {
        await lockReconciliation(tx, orgId, true);
        const current = await tx.payoutReconciliation.findUnique({ where: { id } });
        if (current?.status !== RECON_STATUS.OPEN) throw new ServiceError(409, "Already resolved");
        const saved = await tx.payoutReconciliation.update({
          where: { id },
          data: {
            status: RECON_STATUS.RESOLVED,
            kind: null,
            resolution: RECON_RESOLUTION.MANUAL,
            depositId: deposit.id,
            depositTxnDate: deposit.txnDate,
            depositTotalCents: deposit.totalCents,
            resolvedByUserId: actor.userId,
            resolvedAt: new Date(),
          },
        });
        await audit(tx, orgId, "reconciliation.matched_manually", current, saved, actor);
        return saved;
      });
    } catch (err) {
      if (isUniqueConstraintError(err)) throw new ServiceError(409, "Deposit already backs another payout");
      throw err;
    }
  },

  async dismiss(orgId: string, id: number, reason: string, actor: Actor) {
    const why = reason.trim();
    if (!why) throw new ServiceError(400, "A reason is required");
    await openRow(orgId, id);

    return db.$transaction(async (tx) => {
      await lockReconciliation(tx, orgId, true);
      const current = await tx.payoutReconciliation.findUnique({ where: { id } });
      if (current?.status !== RECON_STATUS.OPEN) throw new ServiceError(409, "Already resolved");
      const saved = await tx.payoutReconciliation.update({
        where: { id },
        data: {
          status: RECON_STATUS.RESOLVED,
          kind: null,
          resolution: RECON_RESOLUTION.DISMISSED,
          reason: why,
          resolvedByUserId: actor.userId,
          resolvedAt: new Date(),
        },
      });
      await audit(tx, orgId, "reconciliation.dismissed", current, saved, { ...actor, reason: why });
      return saved;
    });
  },
};
