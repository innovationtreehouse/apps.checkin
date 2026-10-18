/** In-kind donations: the finance queue for receipt gifts, and gifts recorded without a receipt. */
import { mapServiceErrors, parseBody, parseId } from "@checkin/component-kit";
import { inKindService } from "../services/inKindService";
import { manualInKindService, ManualInKindInputSchema } from "../services/manualInKindService";
import { getOrgId } from "../runtime";
import type { DonationRouteHandler, InKindDonor } from "../contract";
import { auditContext, donorReader, pageArgs } from "./_shared";

export const listQueue: DonationRouteHandler = async () => ({
  InKindQueueItemView: await inKindService.listQueue(await getOrgId()),
});

/** The host decides from the caller's view whether donor identity is read (and audited) at all. */
export function listManual(withDonor: boolean): DonationRouteHandler {
  return async ({ req }) => {
    const reader = withDonor ? await donorReader(req, "GET /api/donations/in-kind/manual") : null;
    return { ManualInKindDonation: await manualInKindService.list(await getOrgId(), reader, pageArgs(req)) };
  };
}

/** `checkDonor` is the host's refusal hook (it throws to refuse); it runs before anything is written. */
export function recordManual(checkDonor: (donor: InKindDonor) => Promise<void>): DonationRouteHandler {
  return async ({ req }) => {
    const input = await parseBody(req, ManualInKindInputSchema);
    await checkDonor(input.donor);
    const orgId = await getOrgId();
    const audit = await auditContext(req);
    return { ManualInKindRecordResult: await mapServiceErrors(() => manualInKindService.record(orgId, input, audit)) };
  };
}

export const loadInventory: DonationRouteHandler = async ({ params }) => {
  const id = parseId(params.id);
  const orgId = await getOrgId();
  await mapServiceErrors(() => manualInKindService.loadInventory(orgId, id));
  return {};
};
