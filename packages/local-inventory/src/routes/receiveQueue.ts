/** Receive-queue route factories: list, cancel, and fulfill into on-hand stock. */
import { mapServiceErrors, parseBody, parseId, query } from "@checkin/component-kit";
import { z } from "zod";
import { getOrgId, getPrincipal, getServices } from "../runtime";
import type { InventoryRouteHandler } from "../contract";

const cancelSchema = z.object({ reason: z.string().trim().min(1, "reason is required") });

export const list: InventoryRouteHandler = async ({ req }) => ({
  ReceiveQueue: await getServices().receiveQueueService.listQueue(
    await getOrgId(),
    query(req).get("includeFulfilled") === "true",
  ),
});

export const remove: InventoryRouteHandler = async ({ req, params }) => {
  const id = parseId(params.id);
  const { reason } = await parseBody(req, cancelSchema);
  const orgId = await getOrgId();
  const principal = await getPrincipal();
  await mapServiceErrors(() =>
    getServices().receiveQueueService.cancel(id, orgId, principal.id, reason, principal.name ?? undefined),
  );
  return {};
};

export const fulfill: InventoryRouteHandler = async ({ params }) => {
  const id = parseId(params.id);
  const orgId = await getOrgId();
  const principal = await getPrincipal();
  return {
    ReceiveQueue: await mapServiceErrors(() =>
      getServices().receiveQueueService.fulfill(id, orgId, principal.id),
    ),
  };
};
