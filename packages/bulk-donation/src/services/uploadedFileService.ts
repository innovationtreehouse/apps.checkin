import * as crypto from "crypto";
import { db, isUniqueConstraintError } from "../db";
import { recordEvent } from "../repositories/audit";
import { isAutoOrganizationalLevel } from "../lib/domain-rules";
import type { BenevityRow } from "../lib/csv-parser";
import { ServiceError } from "@checkin/component-kit";
import { getOwnerDirectory } from "../runtime";
import { lockDisbursementTx, runOwnerAssignedCycleTx, type AuditContext } from "../workflows/disbursement.actor";
import { handOverDeposits } from "../lib/deposit-handover";

const SELECT_FILE_FIELDS = {
  id: true,
  orgId: true,
  uploadedByUserId: true,
  uploadedAt: true,
  originalFilename: true,
  fileHash: true,
  rowCount: true,
  newRowCount: true,
  duplicateRowCount: true,
  allDuplicate: true,
  blobDeleted: true,
} as const;

export const uploadedFileService = {
  async listFiles(orgId: string, page?: { skip: number; take: number }) {
    return db.uploadedFile.findMany({
      where: { orgId },
      select: SELECT_FILE_FIELDS,
      orderBy: [{ uploadedAt: "desc" }, { id: "desc" }],
      ...page,
    });
  },

  async processUpload(
    orgId: string,
    userId: number,
    username: string,
    originalFilename: string,
    buffer: Buffer,
    rows: BenevityRow[],
    correlationId: string | null,
  ) {
    const seen = new Set<string>();
    for (const { transactionId } of rows) {
      if (seen.has(transactionId)) throw new ServiceError(400, `Transaction ${transactionId} appears more than once in this file`);
      seen.add(transactionId);
    }
    const fileHash = crypto.createHash("sha256").update(buffer).digest("hex");
    const rowCount = rows.length;
    const now = new Date();
    const activeOwnerIds = new Set(
      (await getOwnerDirectory().list()).filter((o) => o.archivedAt === null).map((o) => o.id),
    );

    // Rows are deduplicated against committed transactions, so the unique key fires only when a
    // concurrent upload of the same gifts commits first.
    const cycled: string[] = [];
    const result = await db.$transaction(async (tx) => {
      const fileRecord = await tx.uploadedFile.create({
        data: {
          orgId,
          uploadedByUserId: userId,
          uploadedAt: now,
          originalFilename,
          fileBlob: new Uint8Array(buffer),
          fileHash,
          rowCount,
          newRowCount: 0,
          duplicateRowCount: 0,
          allDuplicate: false,
          blobDeleted: false,
        },
      });

      const incomingIds = rows.map((r) => r.transactionId);
      const existingRows =
        incomingIds.length > 0
          ? await tx.transaction.findMany({
              where: { orgId, transactionId: { in: incomingIds } },
              select: { transactionId: true },
            })
          : [];
      const existingIdSet = new Set(existingRows.map((r) => r.transactionId));

      // A gift whose comment matches a rule takes the rule's owner, unless that owner is archived.
      const comments = [...new Set(rows.map((r) => r.donorComment).filter((c) => c.trim() !== ""))];
      const rules =
        comments.length > 0
          ? await tx.transactionCommentRule.findMany({ where: { orgId, comment: { in: comments } } })
          : [];
      const ruleByComment = new Map(
        rules.filter((r) => activeOwnerIds.has(r.ownerId)).map((r) => [r.comment, r]),
      );

      const toInsert = [];
      let duplicateRowCount = 0;
      for (const row of rows) {
        if (existingIdSet.has(row.transactionId)) {
          duplicateRowCount++;
          continue;
        }
        const rule = ruleByComment.get(row.donorComment);
        toInsert.push({
          orgId,
          uploadedFileId: fileRecord.id,
          transactionId: row.transactionId,
          importedAt: now,
          nonprofitName: row.nonprofitName || null,
          nonprofitId: row.nonprofitId || null,
          disbursementId: row.disbursementId || null,
          disbursementDate: row.disbursementDate || null,
          bankDate: row.bankDate || null,
          bankReferenceId: row.bankReferenceId || null,
          paymentMethod: row.paymentMethod || null,
          disbursementFrom: row.disbursementFrom || null,
          projectName: row.projectName || null,
          projectId: row.projectId || null,
          donationDate: row.donationDate || null,
          donationFrequency: row.donationFrequency || null,
          currency: row.currency || "USD",
          foreignExchangeRate: row.foreignExchangeRate,
          companyName: row.companyName || null,
          corporatePeerCampaign: row.corporatePeerCampaign || null,
          donationAmountCents: row.donationAmountCents,
          matchAmountCents: row.matchAmountCents,
          causeSupportFeeCents: row.causeSupportFeeCents,
          merchantFeeCents: row.merchantFeeCents,
          checkFeeCents: row.checkFeeCents,
          donationMethod: row.donationMethod || null,
          donationType: row.donationType || null,
          donorFirstName: row.donorFirstName || null,
          donorLastName: row.donorLastName || null,
          donorComment: row.donorComment || null,
          isOrganizationalLevel: isAutoOrganizationalLevel(row.donorComment),
          ...(rule ? { ownerId: rule.ownerId, ownerAssignedAt: now, ownerAssignedByUserId: userId } : {}),
        });
      }

      // A completed disbursement's payload is final, so a late gift for it would never be booked.
      const newDisbursementIds = [...new Set(toInsert.flatMap((t) => (t.disbursementId ? [t.disbursementId] : [])))].sort();
      for (const disbursementId of newDisbursementIds) await lockDisbursementTx(tx, orgId, disbursementId);
      const completed =
        newDisbursementIds.length > 0
          ? await tx.disbursementEvent.findMany({
              where: { orgId, disbursementId: { in: newDisbursementIds } },
              select: { disbursementId: true },
            })
          : [];
      if (completed.length > 0) {
        const ids = completed.map((c) => c.disbursementId).sort().join(", ");
        throw new ServiceError(
          409,
          `This file has new gifts for disbursements that are already completed (${ids}). Nothing was imported; these gifts need manual booking.`,
        );
      }

      const inserted =
        toInsert.length > 0
          ? await tx.transaction.createManyAndReturn({
              data: toInsert,
              select: { id: true, disbursementId: true, ownerId: true, donorComment: true },
            })
          : [];
      for (const t of inserted) {
        const rule = t.ownerId !== null && t.donorComment ? ruleByComment.get(t.donorComment) : undefined;
        if (!rule) continue;
        await recordEvent(tx, {
          orgId,
          disbursementId: t.disbursementId,
          entityType: "transaction",
          entityId: t.id,
          eventType: "OWNER_ASSIGNED",
          actorUserId: userId,
          actorUsername: username,
          correlationId,
          payload: { ownerId: rule.ownerId, viaCommentRule: true, commentRuleId: rule.id },
        });
      }

      const newRowCount = toInsert.length;
      const allDuplicate = rowCount > 0 && newRowCount === 0;
      await tx.uploadedFile.update({
        where: { id: fileRecord.id },
        data: { newRowCount, duplicateRowCount, allDuplicate },
      });

      await recordEvent(tx, {
        orgId,
        entityType: "uploaded_file",
        entityId: fileRecord.id,
        eventType: "FILE_UPLOADED",
        actorUserId: userId,
        actorUsername: username,
        correlationId,
        payload: { originalFilename, fileHash, rowCount, newRowCount, duplicateRowCount, allDuplicate },
      });

      const audit = { actorUserId: userId, actorUsername: username, correlationId };
      const disbursementIds = new Set(inserted.flatMap((t) => (t.disbursementId ? [t.disbursementId] : [])));
      for (const disbursementId of disbursementIds) {
        await runOwnerAssignedCycleTx(tx, orgId, disbursementId, audit);
      }
      cycled.push(...disbursementIds);

      return { id: fileRecord.id, rowCount, newRowCount, duplicateRowCount, allDuplicate };
    }).catch((err: unknown) => {
      if (isUniqueConstraintError(err)) throw new ServiceError(409, "This file is already being uploaded; retry once that upload finishes");
      throw err;
    });
    await handOverDeposits(orgId, cycled);
    return result;
  },
  /** Drop the stored CSV of an upload that added nothing; the file row stays. */
  async deleteBlob(orgId: string, id: number, audit: AuditContext) {
    const file = await db.uploadedFile.findFirst({ where: { id, orgId }, select: { allDuplicate: true, blobDeleted: true } });
    if (!file) throw new ServiceError(404, "File not found");
    if (!file.allDuplicate) throw new ServiceError(400, "Blob can only be deleted for fully-duplicate uploads");
    if (file.blobDeleted) throw new ServiceError(400, "Blob already deleted");
    await db.$transaction(async (tx) => {
      await tx.uploadedFile.update({ where: { id }, data: { fileBlob: null, blobDeleted: true } });
      await recordEvent(tx, { orgId, entityType: "uploaded_file", entityId: id, eventType: "FILE_BLOB_DELETED", ...audit });
    });
    return { id, blobDeleted: true };
  },
};
