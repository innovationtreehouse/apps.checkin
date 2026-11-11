import { db } from "../db";
import { recordEvent } from "../repositories/audit";
import { lockDisbursementTx, runDisbursementCycleTx, type AuditContext } from "../workflows/disbursement.actor";
import { handOverDeposit } from "../lib/deposit-handover";
import { ServiceError } from "@checkin/component-kit";
import type { AccountMap } from "../generated/prisma/client";
import { z } from "zod";

const matchedRowsSchema = z.array(
  z
    .object({
      id: z.number(),
      orgId: z.string(),
      companyName: z.string(),
      corporatePeerCampaign: z.string(),
      donationMethod: z.string().nullable(),
      donationType: z.string().nullable(),
      donationAccount: z.string(),
      matchAccount: z.string(),
    })
    .passthrough(),
);

function parseMatchedRows(raw: string): AccountMap[] {
  const parsed = matchedRowsSchema.safeParse(JSON.parse(raw));
  return parsed.success ? (parsed.data as unknown as AccountMap[]) : [];
}

export const disbursementService = {
  /** Pending holds as DisbursementHold rows with their transaction; matchedRows parsed from JSON. */
  async listPendingHolds(orgId: string, page?: { skip: number; take: number }) {
    const holds = await db.disbursementHold.findMany({
      where: { orgId, status: "PENDING" },
      include: {
        transaction: {
          select: { companyName: true, corporatePeerCampaign: true, donationMethod: true, donationType: true },
        },
      },
      orderBy: [{ disbursementId: "asc" }, { id: "asc" }],
      ...page,
    });
    return holds.map((hold) => ({ ...hold, matchedRows: parseMatchedRows(hold.matchedRows) }));
  },

  async listEvents(orgId: string, page?: { skip: number; take: number }) {
    return db.disbursementEvent.findMany({ where: { orgId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], ...page });
  },

  async resubmitHold(orgId: string, disbursementId: string, audit: AuditContext) {
    const snapshot = await db.disbursementSnapshot.findFirst({ where: { orgId, disbursementId } });

    if (snapshot?.state !== "on_hold") {
      const displayState = snapshot?.state ?? "awaiting_ownership";
      throw new ServiceError(409, `Cannot resubmit disbursement in state '${displayState}'`);
    }

    await db.$transaction(async (tx) => {
      await recordEvent(tx, {
        orgId,
        disbursementId,
        entityType: "disbursement",
        entityId: disbursementId,
        eventType: "HOLD_RESUBMITTED",
        actorUserId: audit.actorUserId,
        actorUsername: audit.actorUsername,
        correlationId: audit.correlationId,
      });
      await runDisbursementCycleTx(tx, orgId, disbursementId, { type: "HOLD_RESUBMITTED" }, audit);
    });
    await handOverDeposit(orgId, disbursementId);
  },

  /**
   * Finance booked a fees-only row's fee by hand in QuickBooks: stamp the row, release its hold and
   * rerun the cycle so the rest of the disbursement posts without that fee. Final; there is no undo.
   */
  async releaseFeesOnlyHold(orgId: string, disbursementId: string, holdId: number, audit: AuditContext) {
    await db.$transaction(async (tx) => {
      await lockDisbursementTx(tx, orgId, disbursementId);
      const hold = await tx.disbursementHold.findFirst({ where: { id: holdId, orgId, disbursementId } });
      if (hold?.status !== "PENDING" || hold.reason !== "FEES_ONLY") {
        throw new ServiceError(409, "Only a pending fees-only hold of this disbursement can be released");
      }
      const now = new Date();
      await tx.transaction.update({
        where: { id: hold.transactionId },
        data: { feeReleasedAt: now, feeReleasedByUserId: audit.actorUserId ?? null, feeReleasedByName: audit.actorUsername ?? null },
      });
      await tx.disbursementHold.update({ where: { id: hold.id }, data: { status: "RELEASED", resolvedAt: now } });
      await recordEvent(tx, {
        orgId,
        disbursementId,
        entityType: "transaction",
        entityId: hold.transactionId,
        eventType: "HOLD_RELEASED",
        actorUserId: audit.actorUserId,
        actorUsername: audit.actorUsername,
        correlationId: audit.correlationId,
        payload: { holdId: hold.id },
      });
      await runDisbursementCycleTx(tx, orgId, disbursementId, { type: "HOLD_RESUBMITTED" }, audit);
    });
    await handOverDeposit(orgId, disbursementId);
  },
};
