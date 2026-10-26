/**
 * Disbursements: holds and resubmit, completed events, nav counts, and what is left of the
 * QuickBooks finance queue now income owns every deposit (candidates, clearing a note, exclusions read).
 */
import { httpError, mapServiceErrors, parseBody } from "@checkin/component-kit";
import { z } from "zod";
import { db } from "../db";
import { disbursementService } from "../services/disbursementService";
import { getNavCounts } from "../services/navCountsService";
import { getOrgId } from "../runtime";
import { QB_MATCH_STATE } from "../lib/qb-match";
import { qbCandidates as liveQbCandidates, resolveQbHold } from "../lib/qb-queue";
import { NOW_INCOMES, withIncomeStatuses } from "../lib/deposit-handover";
import type { DonationRouteHandler } from "../contract";
import { auditContext, pageArgs } from "./_shared";

const resolveSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("match"), qbTxnId: z.string().trim().min(1, "qbTxnId is required"), reason: z.string().optional() }),
  z.object({ action: z.literal("dismiss"), reason: z.string().trim().min(1, "reason is required") }),
  z.object({ action: z.literal("retry") }),
  z.object({ action: z.literal("book") }),
  z.object({ action: z.literal("clear"), reason: z.string().trim().min(1, "reason is required") }),
]);

const QB_STATES = new Set<string>(Object.values(QB_MATCH_STATE));

/** `?qbState=A,B`: the QuickBooks match states to list; absent lists every event. `&noted=1` adds every record carrying a note. */
function qbStateFilter(req: Request): string[] | undefined {
  const raw = new URL(req.url).searchParams.get("qbState");
  if (raw === null) return undefined;
  const states = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = states.find((s) => !QB_STATES.has(s));
  if (unknown !== undefined || states.length === 0) throw httpError(400, `Unknown qbState: ${unknown ?? raw}`);
  return states;
}

function disbursementId(params: Record<string, string>): string {
  const id = params.disbursementId?.trim();
  if (!id) throw httpError(400, "Invalid disbursementId");
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

/** Completed disbursements, each showing income's status for its deposit once the holdings have moved. */
export const listEvents: DonationRouteHandler = async ({ req }) => {
  const orgId = await getOrgId();
  const rows = await disbursementService.listEvents(orgId, pageArgs(req), qbStateFilter(req), new URL(req.url).searchParams.get("noted") === "1");
  return { DisbursementEvent: await withIncomeStatuses(orgId, rows) };
};

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

/** Income owns every deposit, so its exclusions are income's; a donation exclusion would never be read. */
export const createExclusion: DonationRouteHandler = async () => {
  throw httpError(409, NOW_INCOMES);
};
