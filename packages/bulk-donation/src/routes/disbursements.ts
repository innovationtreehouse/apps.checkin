/**
 * Disbursements: holds and resubmit, completed events, nav counts, and the
 * QuickBooks finance queue (candidates, resolve, exclusions).
 */
import { z } from "zod";
import { db, isUniqueConstraintError } from "../db";
import { disbursementService } from "../services/disbursementService";
import { getNavCounts } from "../services/navCountsService";
import { donationError, getOrgId, mapServiceErrors } from "../runtime";
import { recordEvent } from "../repositories/audit";
import type { DonationRouteHandler } from "../contract";
import { auditContext, pageArgs, parseBody } from "./_shared";

const exclusionSchema = z.object({
  qbTxnId: z.string().trim().min(1, "qbTxnId is required"),
  reason: z.string().trim().min(1, "reason is required"),
});

function disbursementId(params: Record<string, string>): string {
  const id = params.disbursementId?.trim();
  if (!id) throw donationError(400, "Invalid disbursementId");
  return id;
}

async function requireEvent(orgId: string, id: string) {
  const event = await db.disbursementEvent.findFirst({ where: { orgId, disbursementId: id }, select: { id: true } });
  if (!event) throw donationError(404, "Disbursement event not found");
}

export const listHolds: DonationRouteHandler = async ({ req }) => ({
  DisbursementHold: await disbursementService.listPendingHolds(await getOrgId(), pageArgs(req)),
});

export const resubmitHold: DonationRouteHandler = async ({ req, params }) => {
  const id = disbursementId(params);
  const orgId = await getOrgId();
  const audit = await auditContext(req);
  await mapServiceErrors(() => disbursementService.resubmitHold(orgId, id, audit));
  return {};
};

export const listEvents: DonationRouteHandler = async ({ req }) => ({
  DisbursementEvent: await disbursementService.listEvents(await getOrgId(), pageArgs(req)),
});

export const navCounts: DonationRouteHandler = async () => ({
  DonationNavCounts: await getNavCounts(await getOrgId()),
});

// ponytail: QuickBooks candidates need the QB reader the drain (#1280 §9 D) binds; empty until then.
export const qbCandidates: DonationRouteHandler = async ({ params }) => {
  await requireEvent(await getOrgId(), disbursementId(params));
  return { DonationQbCandidateView: [] };
};

// The drain (#1280 §9 D) implements pick / create / retry; until QuickBooks is bound nothing can resolve.
export const qbResolve: DonationRouteHandler = async ({ params }) => {
  await requireEvent(await getOrgId(), disbursementId(params));
  throw donationError(503, "QuickBooks is not connected yet");
};

export const listExclusions: DonationRouteHandler = async ({ req }) => ({
  DonationQbMatchExclusion: await db.donationQbMatchExclusion.findMany({
    where: { orgId: await getOrgId() },
    orderBy: [{ excludedAt: "desc" }, { id: "desc" }],
    ...pageArgs(req),
  }),
});

export const createExclusion: DonationRouteHandler = async ({ req }) => {
  const { qbTxnId, reason } = await parseBody(req, exclusionSchema);
  const orgId = await getOrgId();
  const audit = await auditContext(req);
  try {
    return {
      DonationQbMatchExclusion: await db.$transaction(async (tx) => {
        const row = await tx.donationQbMatchExclusion.create({
          data: { orgId, qbTxnId, reason, excludedByUserId: audit.actorUserId },
        });
        await recordEvent(tx, { orgId, entityType: "qb_exclusion", entityId: row.id, eventType: "QB_TXN_EXCLUDED", ...audit, payload: { qbTxnId } });
        return row;
      }),
    };
  } catch (err) {
    if (isUniqueConstraintError(err)) throw donationError(409, "That QuickBooks entry is already excluded");
    throw err;
  }
};
