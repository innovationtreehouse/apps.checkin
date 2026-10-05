import { db, isUniqueConstraintError } from "../db";
import type { QbDeposit } from "../contract";
import { getIncomeConfig } from "../runtime";
import {
  RECON_KIND,
  RECON_ORIGIN,
  RECON_RESOLUTION,
  RECON_STATUS,
  addDays,
  audit,
  lockReconciliation,
  runReconcile,
  windowDays,
  type ReconStatus,
} from "../lib/reconcile";
import { recordAudit } from "../lib/audit";
import { ServiceError } from "./serviceError";

export interface Actor {
  userId: number;
  username?: string;
  correlationId?: string;
}

/** The three finance resolutions the resolve route accepts. */
export type ResolveAction =
  | { action: "match"; depositId: string }
  | { action: "dismiss"; reason: string }
  | { action: "retry" };

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
  const [deposits, claimed, excluded] = await Promise.all([
    source.depositsSince(new Date(`${from}T00:00:00Z`)),
    db.payoutReconciliation.findMany({
      where: { orgId, depositId: { not: null } },
      select: { depositId: true },
    }),
    db.incomeQbMatchExclusion.findMany({ where: { orgId }, select: { qbTxnId: true } }),
  ]);
  const taken = new Set([...claimed.map((c) => c.depositId), ...excluded.map((e) => e.qbTxnId)]);
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
            origin: RECON_ORIGIN.MATCHED,
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

  listExclusions(orgId: string) {
    return db.incomeQbMatchExclusion.findMany({ where: { orgId }, orderBy: { excludedAt: "desc" } });
  },

  /** Permanently remove a QuickBooks deposit from matching (D5); there is no undo. A held deposit can't be excluded. */
  async excludeDeposit(orgId: string, qbTxnId: string, reason: string, actor: Actor) {
    const why = reason.trim();
    if (!why) throw new ServiceError(400, "A reason is required");

    try {
      return await db.$transaction(async (tx) => {
        await lockReconciliation(tx, orgId, true);
        const holder = await tx.payoutReconciliation.findUnique({
          where: { orgId_depositId: { orgId, depositId: qbTxnId } },
        });
        if (holder) throw new ServiceError(409, "Deposit backs a payout; reopen that payout first");
        const saved = await tx.incomeQbMatchExclusion.create({
          data: { orgId, qbTxnId, reason: why, excludedByUserId: actor.userId },
        });
        await recordAudit(tx, {
          orgId,
          actorUserId: actor.userId,
          actorUsername: actor.username,
          action: "deposit.excluded",
          entityType: "qb_match_exclusion",
          entityId: saved.id,
          after: saved,
          reason: why,
          correlationId: actor.correlationId,
        });
        return saved;
      });
    } catch (err) {
      if (isUniqueConstraintError(err)) throw new ServiceError(409, "Deposit is already excluded");
      throw err;
    }
  },

  /** Re-attempt a failed deposit create. Only a POST_FAILED row qualifies. */
  async retry(orgId: string, id: number, _actor: Actor): Promise<never> {
    const row = await openRow(orgId, id);
    if (row.status !== RECON_STATUS.OPEN || row.kind !== RECON_KIND.POST_FAILED) {
      throw new ServiceError(409, "Only a failed deposit create can be retried");
    }
    // ponytail: no deposit write until L4 ships the shared find-or-create (design §8, PR 4).
    throw new ServiceError(503, "QuickBooks deposit creation is not available");
  },

  resolve(orgId: string, id: number, req: ResolveAction, actor: Actor) {
    switch (req.action) {
      case "match":
        return reconciliationService.matchToDeposit(orgId, id, req.depositId, actor);
      case "dismiss":
        return reconciliationService.dismiss(orgId, id, req.reason, actor);
      case "retry":
        return reconciliationService.retry(orgId, id, actor);
    }
  },
};
