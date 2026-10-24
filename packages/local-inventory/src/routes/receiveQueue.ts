/** Receive-queue route factories: list, cancel, and fulfill into on-hand stock. */
import { mapServiceErrors, parseId, query } from "@checkin/component-kit";
import { getOrgId, getPrincipal, getServices } from "../runtime";
import type { InventoryRouteHandler } from "../contract";

export const list: InventoryRouteHandler = async ({ req }) => ({
  ReceiveQueue: await getServices().receiveQueueService.listQueue(
    await getOrgId(),
    query(req).get("includeFulfilled") === "true",
  ),
});

export const remove: InventoryRouteHandler = async ({ params }) => {
  const id = parseId(params.id);
  const orgId = await getOrgId();
  const principal = await getPrincipal();
  await mapServiceErrors(() =>
    getServices().receiveQueueService.cancel(id, orgId, principal.id, principal.name ?? undefined),
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
