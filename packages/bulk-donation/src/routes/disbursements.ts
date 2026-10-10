/**
 * Disbursements: holds and resubmit, completed events, nav counts, and the
 * QuickBooks finance queue (candidates, resolve, exclusions).
 */
import { z } from "zod";
import { db, isUniqueConstraintError } from "../db";
import { disbursementService } from "../services/disbursementService";
import { getNavCounts } from "../services/navCountsService";
import { donationError, getOrgId, getPrincipal, mapServiceErrors } from "../runtime";
import type { DonationRouteHandler } from "../contract";
import { auditContext, parseBody } from "./_shared";

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

export const listHolds: DonationRouteHandler = async () => ({
  DisbursementHold: await disbursementService.listPendingHolds(await getOrgId()),
});

export const resubmitHold: DonationRouteHandler = async ({ req, params }) => {
  const id = disbursementId(params);
  const orgId = await getOrgId();
  const audit = await auditContext(req);
  await mapServiceErrors(() => disbursementService.resubmitHold(orgId, id, audit));
  return {};
};

export const listEvents: DonationRouteHandler = async () => ({
  DisbursementEvent: await disbursementService.listEvents(await getOrgId()),
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

export const listExclusions: DonationRouteHandler = async () => ({
  DonationQbMatchExclusion: await db.donationQbMatchExclusion.findMany({
    where: { orgId: await getOrgId() },
    orderBy: { excludedAt: "desc" },
  }),
});

export const createExclusion: DonationRouteHandler = async ({ req }) => {
  const { qbTxnId, reason } = await parseBody(req, exclusionSchema);
  const orgId = await getOrgId();
  const principal = await getPrincipal();
  try {
    return {
      DonationQbMatchExclusion: await db.donationQbMatchExclusion.create({
        data: { orgId, qbTxnId, reason, excludedByUserId: principal.id },
      }),
    };
  } catch (err) {
    if (isUniqueConstraintError(err)) throw donationError(409, "That QuickBooks entry is already excluded");
    throw err;
  }
};
