/** Receive-queue route factories: list, cancel, and fulfill into on-hand stock. */
import { getOrgId, getPrincipal, getServices, mapServiceErrors } from "../runtime";
import type { InventoryRouteHandler } from "../contract";
import { parseId, query } from "./_shared";

export const list: InventoryRouteHandler = async ({ req }) => ({
  ReceiveQueue: await getServices().receiveQueueService.listQueue(
    await getOrgId(),
    query(req).get("includeFulfilled") === "true",
  ),
});

export const remove: InventoryRouteHandler = async ({ params }) => {
  const id = parseId(params.id);
  const orgId = await getOrgId();
  await mapServiceErrors(() => getServices().receiveQueueService.cancel(id, orgId));
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
