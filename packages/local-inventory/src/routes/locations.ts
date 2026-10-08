/**
 * Location route factories. The list carries each location's item counts as
 * `_count`, which the screen uses to block deleting a location in use.
 */
import { z } from "zod";
import { db } from "../lib/db";
import { getOrg, getPrincipal, getServices, mapServiceErrors } from "../runtime";
import type { InventoryRouteHandler } from "../contract";
import { parseBody, parseId } from "./_shared";

const nameSchema = z.object({ name: z.string().trim().min(1, "name is required") });
const reassignSchema = z.object({ targetLocationId: z.number().int().positive("targetLocationId is required") });

export const list: InventoryRouteHandler = async () => ({
  Location: await db.location.findMany({
    where: { orgId: getOrg().id },
    orderBy: { name: "asc" },
    include: { _count: { select: { primaryItems: true, backstockItems: true } } },
  }),
});

export const create: InventoryRouteHandler = async ({ req }) => {
  const { name } = await parseBody(req, nameSchema);
  const principal = await getPrincipal();
  const location = await getServices().locationService.createLocation(
    getOrg().id, name, principal.id, principal.name ?? undefined,
  );
  return { Location: location };
};

export const update: InventoryRouteHandler = async ({ req, params }) => {
  const id = parseId(params.id);
  const { name } = await parseBody(req, nameSchema);
  const principal = await getPrincipal();
  const location = await mapServiceErrors(() =>
    getServices().locationService.updateLocation(id, getOrg().id, name, principal.id, principal.name ?? undefined),
  );
  return { Location: location };
};

export const remove: InventoryRouteHandler = async ({ params }) => {
  const id = parseId(params.id);
  const principal = await getPrincipal();
  await mapServiceErrors(() =>
    getServices().locationService.deleteLocation(id, getOrg().id, principal.id, principal.name ?? undefined),
  );
  return {};
};

export const reassign: InventoryRouteHandler = async ({ req, params }) => {
  const id = parseId(params.id);
  const { targetLocationId } = await parseBody(req, reassignSchema);
  const principal = await getPrincipal();
  await mapServiceErrors(() =>
    getServices().locationService.reassignLocation(
      id, targetLocationId, getOrg().id, principal.id, principal.name ?? undefined,
    ),
  );
  return {};
};
