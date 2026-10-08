/** Provisional items and the uom_mismatch merge-conflict queue (manager-only). */
import { z } from "zod";
import { db } from "../lib/db";
import { getOrg, getPrincipal, getServices, mapServiceErrors } from "../runtime";
import type { InventoryRouteHandler } from "../contract";
import { parseBody, parseId } from "./_shared";

const resolveSchema = z.object({ quantityMethod: z.enum(["use_provisional", "use_existing", "sum"]) });

export const provisionalItems: InventoryRouteHandler = async () => ({
  InventoryProvisionalItem: await getServices().provisionalItemService.listProvisionals(getOrg().id),
});

export const mergeConflicts: InventoryRouteHandler = async () => ({
  InventoryMergeConflict: await db.inventoryMergeConflict.findMany({
    where: { orgId: getOrg().id },
    orderBy: { id: "desc" },
  }),
});

export const resolveMergeConflict: InventoryRouteHandler = async ({ req, params }) => {
  const id = parseId(params.id);
  const resolution = await parseBody(req, resolveSchema);
  const principal = await getPrincipal();
  await mapServiceErrors(() =>
    getServices().provisionalItemService.resolveConflict(
      id, getOrg().id, resolution, principal.id, principal.name ?? undefined,
    ),
  );
  return { InventoryMergeConflict: await db.inventoryMergeConflict.findUnique({ where: { id } }) };
};
