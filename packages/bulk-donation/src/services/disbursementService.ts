import { db } from "../db";
import { recordEvent } from "../repositories/audit";
import { runDisbursementCycleTx, type AuditContext } from "../workflows/disbursement.actor";
import { ServiceError } from "./serviceError";
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
      feesAccount: z.string(),
    })
    .passthrough(),
);

function parseMatchedRows(raw: string): AccountMap[] {
  const parsed = matchedRowsSchema.safeParse(JSON.parse(raw));
  return parsed.success ? (parsed.data as unknown as AccountMap[]) : [];
}

export const disbursementService = {
  async getHoldsGrouped(orgId: string) {
    const holds = await db.disbursementHold.findMany({
      where: { orgId, status: "PENDING" },
      include: {
        transaction: {
          select: { companyName: true, corporatePeerCampaign: true, donationMethod: true, donationType: true },
        },
      },
      orderBy: [{ disbursementId: "asc" }, { id: "asc" }],
    });

    type HoldWithTx = (typeof holds)[number] & { matchedRows: AccountMap[] };
    const grouped: Record<string, HoldWithTx[]> = {};
    for (const hold of holds) {
      const { transaction: tx, ...rest } = hold;
      const row = {
        ...rest,
        txCompanyName: tx?.companyName ?? null,
        txCorporatePeerCampaign: tx?.corporatePeerCampaign ?? null,
        txDonationMethod: tx?.donationMethod ?? null,
        txDonationType: tx?.donationType ?? null,
        matchedRows: parseMatchedRows(hold.matchedRows),
      } as unknown as HoldWithTx;
      if (!grouped[hold.disbursementId]) grouped[hold.disbursementId] = [];
      grouped[hold.disbursementId].push(row);
    }

    return grouped;
  },

  async listEvents(orgId: string) {
    return db.disbursementEvent.findMany({ where: { orgId }, orderBy: { createdAt: "desc" } });
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
  },
};
