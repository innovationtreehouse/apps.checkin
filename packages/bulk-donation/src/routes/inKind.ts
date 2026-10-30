/** In-kind gifts: the finance queue and its accept step, gifts recorded without a receipt, and the approvers' view. */
import { mapServiceErrors, parseId } from "@checkin/component-kit";
import { z } from "zod";
import { InKindQbResolveInputSchema, resolveInKindQb } from "../lib/in-kind-resolve";
import { inKindService } from "../services/inKindService";
import { inKindAcceptService, InKindDecisionInputSchema, type InKindSource } from "../services/inKindAcceptService";
import { manualInKindService, ManualInKindInputSchema } from "../services/manualInKindService";
import { getOrgId, getPrincipal } from "../runtime";
import type { DonationRouteHandler, InKindDonor } from "../contract";
import { auditContext, pageArgs, parseBodyCapped } from "./_shared";

export const listQueue: DonationRouteHandler = async () => ({
  InKindQueueItemView: await inKindAcceptService.listQueue(await getOrgId(), (await getPrincipal()).id),
});

/** Accept, refuse or return one gift; the service refuses a conflicted caller. */
export function decide(source: InKindSource): DonationRouteHandler {
  return async ({ req, params }) => {
    const id = parseId(params.id);
    const input = await parseBodyCapped(req, InKindDecisionInputSchema);
    const audit = await auditContext(req);
    return { InKindDecisionView: await mapServiceErrors(() => inKindAcceptService.decide(source, id, input, audit)) };
  };
}

/** Finance books, skips (with a reason) or matches by id a gift the QuickBooks drain handed over; replies with its queue row. */
export function qbResolve(source: InKindSource): DonationRouteHandler {
  return async ({ req, params }) => {
    const id = parseId(params.id);
    const input = await parseBodyCapped(req, InKindQbResolveInputSchema);
    const orgId = await getOrgId();
    const audit = await auditContext(req);
    return { InKindQueueItemView: await mapServiceErrors(() => resolveInKindQb(orgId, source, id, input, audit)) };
  };
}

const SettleInputSchema = z.object({ kind: z.enum(["withdrawal", "replay"]) });

/** Finance settles a receipt gift's withdrawal or replay conflict. */
export const settleReceipt: DonationRouteHandler = async ({ req, params }) => {
  const id = parseId(params.id);
  const { kind } = await parseBodyCapped(req, SettleInputSchema);
  const orgId = await getOrgId();
  const audit = await auditContext(req);
  return { InKindSettleResult: await mapServiceErrors(() => inKindService.settle(orgId, id, kind, audit)) };
};

/** One gift for its page. */
export function getGift(source: InKindSource): DonationRouteHandler {
  return async ({ params }) => {
    const id = parseId(params.id);
    const orgId = await getOrgId();
    return { InKindGiftDetailView: await mapServiceErrors(() => inKindAcceptService.getGift(orgId, source, id)) };
  };
}

/** The host decides from the caller's view whether every bucket is shown or only those the caller approves. */
export function listByBucket(seeAll: boolean): DonationRouteHandler {
  return async () => ({
    InKindBucketGiftView: await inKindAcceptService.listByBucket(await getOrgId(), (await getPrincipal()).id, seeAll),
  });
}

/** The host decides from the caller's view whether donor identity is read at all. */
export function listManual(withDonor: boolean): DonationRouteHandler {
  return async ({ req }) => {
    return { ManualInKindDonation: await manualInKindService.list(await getOrgId(), withDonor, pageArgs(req)) };
  };
}

/** `checkDonor` is the host's refusal hook (it throws to refuse); it runs before anything is written. */
export function recordManual(checkDonor: (donor: InKindDonor) => Promise<void>): DonationRouteHandler {
  return async ({ req }) => {
    const input = await parseBodyCapped(req, ManualInKindInputSchema);
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
