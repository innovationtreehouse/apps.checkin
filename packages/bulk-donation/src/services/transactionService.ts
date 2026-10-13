import { db } from "../db";
import { recordDonorDataRead, recordEvent, type DonorReadContext } from "../repositories/audit";
import { getOwnerDirectory } from "../runtime";
import { runOwnerAssignedCycleTx, type AuditContext } from "../workflows/disbursement.actor";
import { ServiceError } from "./serviceError";

const TRANSACTION_SELECT = {
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
  donorFirstName: true,
  donorLastName: true,
  donorComment: true,
  ownerId: true,
  ownerAssignedAt: true,
  ownerAssignedByUserId: true,
  isOrganizationalLevel: true,
  currency: true,
  donationDate: true,
} as const;

export const transactionService = {
  async listTransactions(orgId: string, reader: DonorReadContext, assigned?: "true" | "false") {
    let where;
    if (assigned === "true") {
      where = { orgId, OR: [{ ownerId: { not: null } }, { isOrganizationalLevel: true }] };
    } else if (assigned === "false") {
      where = { orgId, ownerId: null as null, isOrganizationalLevel: false };
    } else {
      where = { orgId };
    }
    const rows = await db.transaction.findMany({ where, select: TRANSACTION_SELECT, orderBy: { importedAt: "asc" } });
    await recordDonorDataRead(db, orgId, "transaction", reader, { filter: { assigned: assigned ?? null }, count: rows.length });
    return rows;
  },

  async listUnassignedTransactions(orgId: string, reader: DonorReadContext) {
    const rows = await db.transaction.findMany({
      where: { orgId, ownerId: null, isOrganizationalLevel: false },
      select: TRANSACTION_SELECT,
      orderBy: { importedAt: "asc" },
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

    return db.$transaction(async (tx) => {
      const row = await tx.transaction.update({
        where: { id: transactionId },
        data: { ownerId, ownerAssignedAt: now, ownerAssignedByUserId: audit.actorUserId },
      });

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

      for (const disbId of affectedDisbursementIds) {
        await runOwnerAssignedCycleTx(tx, orgId, disbId, audit);
      }

      return row;
    });
  },

  async markOrganizationalLevel(orgId: string, transactionId: number, audit: AuditContext) {
    const existing = await db.transaction.findFirst({ where: { id: transactionId, orgId } });
    if (!existing) throw new ServiceError(404, "Transaction not found");
    if (existing.ownerId !== null) throw new ServiceError(400, "Owner already assigned — record is finalized");
    if (existing.isOrganizationalLevel) throw new ServiceError(400, "Already marked Organizational Level");

    return db.$transaction(async (tx) => {
      const row = await tx.transaction.update({
        where: { id: transactionId },
        data: { isOrganizationalLevel: true },
      });

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
  },
};
