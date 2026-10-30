/** Disbursements: holds and resubmit, completed events, nav counts. */
import { httpError, mapServiceErrors } from "@checkin/component-kit";
import { disbursementService } from "../services/disbursementService";
import { getNavCounts } from "../services/navCountsService";
import { getOrgId } from "../runtime";
import type { DonationRouteHandler } from "../contract";
import { auditContext, pageArgs } from "./_shared";

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

export const listEvents: DonationRouteHandler = async ({ req }) => ({
  DisbursementEvent: await disbursementService.listEvents(await getOrgId(), pageArgs(req)),
});

export const navCounts: DonationRouteHandler = async () => ({
  DonationNavCounts: await getNavCounts(await getOrgId()),
});
