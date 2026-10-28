import { db, type DbOrTx } from "../db";
import { recordDonorDataRead, recordEvent, type DonorReadContext } from "../repositories/audit";
import { getOwnerDirectory } from "../runtime";
import { runOwnerAssignedCycleTx, type AuditContext } from "../workflows/disbursement.actor";
import { handOverDeposit, handOverDeposits } from "../lib/deposit-handover";
import { ServiceError } from "@checkin/component-kit";

// Owner decisions return the row without donor identity, so the writes need no donor-read audit row.
const DECISION_SELECT = {
  id: true,
  orgId: true,
  uploadedFileId: true,
  transactionId: true,
  importedAt: true,
  companyName: true,
  corporatePeerCampaign: true,
  donationAmountCents: true,
  matchAmountCents: true,
  causeSupportFeeCents: true,
  merchantFeeCents: true,
  checkFeeCents: true,
  donationMethod: true,
  donationType: true,
  ownerId: true,
  ownerAssignedAt: true,
  ownerAssignedByUserId: true,
  isOrganizationalLevel: true,
  currency: true,
  donationDate: true,
} as const;

const TRANSACTION_SELECT = {
  ...DECISION_SELECT,
  donorFirstName: true,
  donorLastName: true,
  donorComment: true,
} as const;

/** Writes the owner decision only while the gift is still undecided; a concurrent decision gets a 409. */
async function claimUndecided(
  tx: DbOrTx,
  orgId: string,
  transactionId: number,
  data: { ownerId: number; ownerAssignedAt: Date; ownerAssignedByUserId: number | null | undefined } | { isOrganizationalLevel: true },
) {
  const { count } = await tx.transaction.updateMany({
    where: { id: transactionId, orgId, ownerId: null, isOrganizationalLevel: false },
    data,
  });
  if (count === 0) throw new ServiceError(409, "Owner decision already recorded for this transaction");
}

export const transactionService = {
  async listTransactions(orgId: string, reader: DonorReadContext, assigned?: "true" | "false", page?: { skip: number; take: number }) {
    let where;
    if (assigned === "true") {
      where = { orgId, OR: [{ ownerId: { not: null } }, { isOrganizationalLevel: true }] };
    } else if (assigned === "false") {
      where = { orgId, ownerId: null as null, isOrganizationalLevel: false };
    } else {
      where = { orgId };
    }
    const rows = await db.transaction.findMany({ where, select: TRANSACTION_SELECT, orderBy: [{ importedAt: "asc" }, { id: "asc" }], ...page });
    await recordDonorDataRead(db, orgId, "transaction", reader, { filter: { assigned: assigned ?? null }, count: rows.length });
    return rows;
  },

  async listUnassignedTransactions(orgId: string, reader: DonorReadContext, page?: { skip: number; take: number }) {
    const rows = await db.transaction.findMany({
      where: { orgId, ownerId: null, isOrganizationalLevel: false },
      select: TRANSACTION_SELECT,
      orderBy: [{ importedAt: "asc" }, { id: "asc" }],
      ...page,
    });
    await recordDonorDataRead(db, orgId, "transaction", reader, { filter: { unassigned: true }, count: rows.length });
    return rows;
  },

  async getTransaction(orgId: string, id: number, reader: DonorReadContext) {
    const row = await db.transaction.findFirst({ where: { id, orgId } });
    if (row) await recordDonorDataRead(db, orgId, "transaction", reader, { ids: [row.id], count: 1 });
    return row;
  },

  async assignOwner(
    orgId: string,
    transactionId: number,
    ownerId: number,
    assignFutureMatchingComment: boolean,
    audit: AuditContext,
  ) {
    const existing = await db.transaction.findFirst({ where: { id: transactionId, orgId } });
    if (!existing) throw new ServiceError(404, "Transaction not found");
    if (existing.ownerId !== null) throw new ServiceError(400, "Owner already assigned — record is finalized");
    if (existing.isOrganizationalLevel) throw new ServiceError(400, "Record is marked Organizational Level — cannot assign owner");
    const owner = (await getOwnerDirectory().list()).find((o) => o.id === ownerId);
    if (!owner) throw new ServiceError(400, "Unknown owner");
    if (owner.archivedAt) throw new ServiceError(400, "Owner is archived — cannot assign");

    const now = new Date();
    const useCommentRule = Boolean(assignFutureMatchingComment && existing.donorComment);

    const cycled: string[] = [];
    const saved = await db.$transaction(async (tx) => {
      await claimUndecided(tx, orgId, transactionId, { ownerId, ownerAssignedAt: now, ownerAssignedByUserId: audit.actorUserId });
      const row = await tx.transaction.findUniqueOrThrow({ where: { id: transactionId }, select: DECISION_SELECT });

      await recordEvent(tx, {
        orgId,
        disbursementId: existing.disbursementId ?? null,
        entityType: "transaction",
        entityId: transactionId,
        eventType: "OWNER_ASSIGNED",
        actorUserId: audit.actorUserId,
        actorUsername: audit.actorUsername,
        correlationId: audit.correlationId,
        payload: { ownerId, viaCommentRule: useCommentRule },
      });

      const affectedDisbursementIds = new Set<string>();
      if (existing.disbursementId) affectedDisbursementIds.add(existing.disbursementId);

      if (useCommentRule && existing.donorComment) {
        await tx.transactionCommentRule.upsert({
          where: { orgId_comment: { orgId, comment: existing.donorComment } },
          create: { orgId, comment: existing.donorComment, ownerId, createdByUserId: audit.actorUserId! },
          update: { ownerId, createdByUserId: audit.actorUserId! },
        });

        const bulkUpdated = await tx.transaction.findMany({
          where: { orgId, donorComment: existing.donorComment, ownerId: null, isOrganizationalLevel: false },
          select: { id: true, disbursementId: true },
        });

        if (bulkUpdated.length > 0) {
          await tx.transaction.updateMany({
            where: { orgId, donorComment: existing.donorComment, ownerId: null, isOrganizationalLevel: false },
            data: { ownerId, ownerAssignedAt: now, ownerAssignedByUserId: audit.actorUserId },
          });
        }

        for (const t of bulkUpdated) {
          await recordEvent(tx, {
            orgId,
            disbursementId: t.disbursementId ?? null,
            entityType: "transaction",
            entityId: t.id,
            eventType: "OWNER_ASSIGNED",
            actorUserId: audit.actorUserId,
            actorUsername: audit.actorUsername,
            correlationId: audit.correlationId,
            payload: { ownerId, viaCommentRule: true, sourceTransactionId: transactionId },
          });
          if (t.disbursementId) affectedDisbursementIds.add(t.disbursementId);
        }
      }

      for (const disbId of [...affectedDisbursementIds].sort()) {
        await runOwnerAssignedCycleTx(tx, orgId, disbId, audit);
      }
      cycled.push(...affectedDisbursementIds);

      return row;
    });
    await handOverDeposits(orgId, cycled);
    return saved;
  },

  async markOrganizationalLevel(orgId: string, transactionId: number, audit: AuditContext) {
    const existing = await db.transaction.findFirst({ where: { id: transactionId, orgId } });
    if (!existing) throw new ServiceError(404, "Transaction not found");
    if (existing.ownerId !== null) throw new ServiceError(400, "Owner already assigned — record is finalized");
    if (existing.isOrganizationalLevel) throw new ServiceError(400, "Already marked Organizational Level");

    const marked = await db.$transaction(async (tx) => {
      await claimUndecided(tx, orgId, transactionId, { isOrganizationalLevel: true });
      const row = await tx.transaction.findUniqueOrThrow({ where: { id: transactionId }, select: DECISION_SELECT });

      await recordEvent(tx, {
        orgId,
        disbursementId: existing.disbursementId ?? null,
        entityType: "transaction",
        entityId: transactionId,
        eventType: "ORG_LEVEL_MARKED",
        actorUserId: audit.actorUserId,
        actorUsername: audit.actorUsername,
        correlationId: audit.correlationId,
      });

      if (existing.disbursementId) {
        await runOwnerAssignedCycleTx(tx, orgId, existing.disbursementId, audit);
      }

      return row;
    });
    if (existing.disbursementId) await handOverDeposit(orgId, existing.disbursementId);
    return marked;
  },
};
