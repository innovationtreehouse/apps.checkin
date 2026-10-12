import * as crypto from "crypto";
import { db } from "../db";
import { recordEvent } from "../repositories/audit";
import { isAutoOrganizationalLevel } from "../lib/domain-rules";
import type { BenevityRow } from "../lib/csv-parser";
import { ServiceError } from "./serviceError";
import { getOwnerDirectory } from "../runtime";
import { runOwnerAssignedCycleTx } from "../workflows/disbursement.actor";

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
  async listFiles(orgId: string) {
    return db.uploadedFile.findMany({
      where: { orgId },
      select: SELECT_FILE_FIELDS,
      orderBy: { uploadedAt: "desc" },
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
    const fileHash = crypto.createHash("sha256").update(buffer).digest("hex");
    const rowCount = rows.length;
    const now = new Date();
    const activeOwnerIds = new Set(
      (await getOwnerDirectory().list()).filter((o) => o.archivedAt === null).map((o) => o.id),
    );

    return db.$transaction(async (tx) => {
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

      return { id: fileRecord.id, rowCount, newRowCount, duplicateRowCount, allDuplicate };
    });
  },
  /** Drop the stored CSV of an upload that added nothing; the file row stays. */
  async deleteBlob(orgId: string, id: number) {
    const file = await db.uploadedFile.findFirst({ where: { id, orgId }, select: { allDuplicate: true, blobDeleted: true } });
    if (!file) throw new ServiceError(404, "File not found");
    if (!file.allDuplicate) throw new ServiceError(400, "Blob can only be deleted for fully-duplicate uploads");
    if (file.blobDeleted) throw new ServiceError(400, "Blob already deleted");
    await db.uploadedFile.update({ where: { id }, data: { fileBlob: null, blobDeleted: true } });
    return { id, blobDeleted: true };
  },
};
