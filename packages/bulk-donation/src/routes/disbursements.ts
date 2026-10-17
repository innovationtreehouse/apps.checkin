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
import { QB_MATCH_STATE } from "../lib/qb-match";
import { qbCandidates as liveQbCandidates, resolveQbHold } from "../lib/qb-queue";
import type { DonationRouteHandler } from "../contract";
import { auditContext, pageArgs, parseBody } from "./_shared";

const exclusionSchema = z.object({
  qbTxnId: z.string().trim().min(1, "qbTxnId is required"),
  reason: z.string().trim().min(1, "reason is required"),
});

const resolveSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("match"), qbTxnId: z.string().trim().min(1, "qbTxnId is required"), reason: z.string().optional() }),
  z.object({ action: z.literal("dismiss"), reason: z.string().trim().min(1, "reason is required") }),
  z.object({ action: z.literal("retry") }),
]);

const QB_STATES = new Set<string>(Object.values(QB_MATCH_STATE));

/** `?qbState=A,B`: the QuickBooks match states to list; absent lists every event. */
function qbStateFilter(req: Request): string[] | undefined {
  const raw = new URL(req.url).searchParams.get("qbState");
  if (raw === null) return undefined;
  const states = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = states.find((s) => !QB_STATES.has(s));
  if (unknown !== undefined || states.length === 0) throw donationError(400, `Unknown qbState: ${unknown ?? raw}`);
  return states;
}

function disbursementId(params: Record<string, string>): string {
  const id = params.disbursementId?.trim();
  if (!id) throw donationError(400, "Invalid disbursementId");
  return id;
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
  DisbursementEvent: await disbursementService.listEvents(await getOrgId(), pageArgs(req), qbStateFilter(req)),
});

export const navCounts: DonationRouteHandler = async () => ({
  DonationNavCounts: await getNavCounts(await getOrgId()),
});

export const qbCandidates: DonationRouteHandler = async ({ params }) => {
  const id = disbursementId(params);
  const orgId = await getOrgId();
  return { DonationQbCandidateView: await mapServiceErrors(() => liveQbCandidates(orgId, id)) };
};

export const qbResolve: DonationRouteHandler = async ({ req, params }) => {
  const id = disbursementId(params);
  const action = await parseBody(req, resolveSchema);
  const orgId = await getOrgId();
  const audit = await auditContext(req);
  return { DisbursementEvent: await mapServiceErrors(() => resolveQbHold(orgId, id, action, audit)) };
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
        const holder = await tx.disbursementEvent.findFirst({ where: { orgId, qbTxnId }, select: { disbursementId: true } });
        if (holder) throw donationError(409, `That QuickBooks entry backs disbursement ${holder.disbursementId}`);
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
