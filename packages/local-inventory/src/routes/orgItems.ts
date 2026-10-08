/**
 * Org-item route factories. Rows carry their `location` / `backstockLocation`
 * relations, which the host stripper recurses into. Catalog item names are not
 * here — they live in the catalog's database.
 */
import { z } from "zod";
import type { Prisma } from "../generated/prisma/client";
import { db } from "../lib/db";
import { getOrg, getPrincipal, getServices, inventoryError, mapServiceErrors } from "../runtime";
import type { InventoryRouteHandler } from "../contract";
import { pageArgs, parseBody, query } from "./_shared";

const include = { location: true, backstockLocation: true } as const;

const quantity = z.number().int().min(0);
const locationRef = z.number().int().positive().nullable();
const createSchema = z.object({
  gtin13: z.string().regex(/^\d{13}$/, "gtin13 must be 13 digits"),
  existingQuantity: quantity.optional(),
  desiredQuantity: quantity.optional(),
  locationId: locationRef.optional(),
  backstockLocationId: locationRef.optional(),
});
const updateSchema = createSchema.omit({ gtin13: true }).strict();

/** The filter shared by the list and its count, so page totals match rows. */
function itemWhere(sp: URLSearchParams): Prisma.OrgItemWhereInput {
  const where: Prisma.OrgItemWhereInput = { orgId: getOrg().id };
  if (sp.get("unlocated") === "true") where.locationId = null;
  const q = sp.get("q")?.trim();
  if (q) {
    where.OR = [
      { gtin13: { contains: q.replace(/\D/g, "") || q } },
      { location: { name: { contains: q, mode: "insensitive" } } },
      { backstockLocation: { name: { contains: q, mode: "insensitive" } } },
    ];
  }
  return where;
}

async function findItem(gtin13: string) {
  return db.orgItem.findFirst({ where: { orgId: getOrg().id, gtin13 }, include });
}

export const list: InventoryRouteHandler = async ({ req }) => {
  const sp = query(req);
  return {
    OrgItem: await db.orgItem.findMany({
      where: itemWhere(sp),
      orderBy: { gtin13: "asc" },
      include,
      ...pageArgs(sp),
    }),
  };
};

export const count: InventoryRouteHandler = async ({ req }) => ({
  InventoryCount: { total: await db.orgItem.count({ where: itemWhere(query(req)) }) },
});

export const get: InventoryRouteHandler = async ({ params }) => {
  const item = await findItem(params.gtin13);
  if (!item) throw inventoryError(404, "Organization item not found");
  return { OrgItem: item };
};

export const create: InventoryRouteHandler = async ({ req }) => {
  const data = await parseBody(req, createSchema);
  const principal = await getPrincipal();
  await mapServiceErrors(() =>
    getServices().inventoryService.createItem(getOrg().id, data, principal.id, principal.name ?? undefined),
  );
  return { OrgItem: await findItem(data.gtin13) };
};

export const update: InventoryRouteHandler = async ({ req, params }) => {
  const data = await parseBody(req, updateSchema);
  const principal = await getPrincipal();
  await mapServiceErrors(() =>
    getServices().inventoryService.updateItem(getOrg().id, params.gtin13, data, principal.id, principal.name ?? undefined),
  );
  return { OrgItem: await findItem(params.gtin13) };
};

export const remove: InventoryRouteHandler = async ({ params }) => {
  await mapServiceErrors(() => getServices().inventoryService.deleteItem(getOrg().id, params.gtin13));
  return {};
};
