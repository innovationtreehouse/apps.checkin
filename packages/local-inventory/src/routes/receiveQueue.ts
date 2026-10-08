/** Receive-queue route factories: list, cancel, and fulfill into on-hand stock. */
import { getOrg, getPrincipal, getServices, mapServiceErrors } from "../runtime";
import type { InventoryRouteHandler } from "../contract";
import { parseId, query } from "./_shared";

export const list: InventoryRouteHandler = async ({ req }) => ({
  ReceiveQueue: await getServices().receiveQueueService.listQueue(
    getOrg().id,
    query(req).get("includeFulfilled") === "true",
  ),
});

export const remove: InventoryRouteHandler = async ({ params }) => {
  const id = parseId(params.id);
  await mapServiceErrors(() => getServices().receiveQueueService.cancel(id, getOrg().id));
  return {};
};

export const fulfill: InventoryRouteHandler = async ({ params }) => {
  const id = parseId(params.id);
  const principal = await getPrincipal();
  return {
    ReceiveQueue: await mapServiceErrors(() =>
      getServices().receiveQueueService.fulfill(id, getOrg().id, principal.id),
    ),
  };
};
