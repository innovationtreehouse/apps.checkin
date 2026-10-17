/** Provisional items and the uom_mismatch merge-conflict queue (manager-only). */
import { z } from "zod";
import { db } from "../lib/db";
import { getOrgId, getPrincipal, getServices, mapServiceErrors } from "../runtime";
import type { InventoryRouteHandler } from "../contract";
import { parseBody, parseId } from "./_shared";

const resolveSchema = z.object({ quantityMethod: z.enum(["use_provisional", "use_existing", "sum"]) });

export const provisionalItems: InventoryRouteHandler = async () => ({
  InventoryProvisionalItem: await getServices().provisionalItemService.listProvisionals(await getOrgId()),
});

export const mergeConflicts: InventoryRouteHandler = async () => ({
  InventoryMergeConflict: await db.inventoryMergeConflict.findMany({
    where: { orgId: await getOrgId() },
    orderBy: { id: "desc" },
  }),
});

export const resolveMergeConflict: InventoryRouteHandler = async ({ req, params }) => {
  const id = parseId(params.id);
  const resolution = await parseBody(req, resolveSchema);
  const orgId = await getOrgId();
  const principal = await getPrincipal();
  await mapServiceErrors(() =>
    getServices().provisionalItemService.resolveConflict(
      id, orgId, resolution, principal.id, principal.name ?? undefined,
    ),
  );
  return { InventoryMergeConflict: await db.inventoryMergeConflict.findUnique({ where: { id } }) };
};
