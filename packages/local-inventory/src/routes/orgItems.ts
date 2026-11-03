/**
 * Org-item route factories. Rows carry their `location` / `backstockLocation`
 * relations, which the host stripper recurses into. Catalog item names are not
 * here — they live in the catalog's database.
 */
import { formatGtinDisplay, isValidGtin13, parseGtinInput } from "@checkin/gtin";
import { httpError, mapServiceErrors, parseBody, query } from "@checkin/component-kit";
import { z } from "zod";
import type { Prisma } from "../generated/prisma/client";
import { db } from "../lib/db";
import { catalogHasActiveItem, getOrgId, getPrincipal, getServices, unlocatedWhere } from "../runtime";
import type { InventoryRouteHandler } from "../contract";
import { pageArgs } from "./_shared";

const include = { location: true, backstockLocation: true } as const;

const quantity = z.number().int().min(0);
const locationRef = z.number().int().positive().nullable();
const createSchema = z.object({
  gtin13: z.string().refine(isValidGtin13, "gtin13 must be 13 digits with a valid check digit"),
  existingQuantity: quantity.optional(),
  desiredQuantity: quantity.optional(),
  locationId: locationRef.optional(),
  backstockLocationId: locationRef.optional(),
});
const updateSchema = createSchema
  .omit({ gtin13: true })
  .extend({
    expectedQuantity: quantity.optional(),
    expectedDesiredQuantity: quantity.optional(),
    expectedLocationId: locationRef.optional(),
    expectedBackstockLocationId: locationRef.optional(),
  })
  .strict();

/** What the search box matches: GTIN, location, backstock, or the GTIN a typed short ID stands for. */
export function itemSearch(q: string): Prisma.OrgItemWhereInput[] {
  const gtin13 = parseGtinInput(q);
  return [
    { gtin13: { contains: q } },
    ...(gtin13 ? [{ gtin13 }] : []),
    { location: { name: { contains: q, mode: "insensitive" } } },
    { backstockLocation: { name: { contains: q, mode: "insensitive" } } },
  ];
}

/** The filter shared by the list and its count, so page totals match rows. */
async function itemWhere(sp: URLSearchParams): Promise<Prisma.OrgItemWhereInput> {
  const orgId = await getOrgId();
  const where: Prisma.OrgItemWhereInput = sp.get("unlocated") === "true" ? unlocatedWhere(orgId) : { orgId };
  const q = sp.get("q")?.trim();
  if (q) where.OR = itemSearch(q);
  return where;
}

/**
 * The list order from `sortBy` (gtin13, location or backstock) and `sortDir`, default part
 * number ascending. Names live in the catalog's database, so the list cannot order by name.
 */
export function itemOrderBy(sp: URLSearchParams): Prisma.OrgItemOrderByWithRelationInput[] {
  const dir: Prisma.SortOrder = sp.get("sortDir") === "desc" ? "desc" : "asc";
  switch (sp.get("sortBy")) {
    case "location": return [{ location: { name: dir } }, { gtin13: "asc" }];
    case "backstock": return [{ backstockLocation: { name: dir } }, { gtin13: "asc" }];
    default: return [{ gtin13: dir }];
  }
}

async function findItem(gtin13: string) {
  return db.orgItem.findFirst({ where: { orgId: await getOrgId(), gtin13 }, include });
}

export const list: InventoryRouteHandler = async ({ req }) => {
  const sp = query(req);
  return {
    OrgItem: await db.orgItem.findMany({
      where: await itemWhere(sp),
      orderBy: itemOrderBy(sp),
      include,
      ...pageArgs(sp),
    }),
  };
};

export const count: InventoryRouteHandler = async ({ req }) => ({
  InventoryCount: { total: await db.orgItem.count({ where: await itemWhere(query(req)) }) },
});

export const get: InventoryRouteHandler = async ({ params }) => {
  const item = await findItem(params.gtin13);
  if (!item) throw httpError(404, "Organization item not found");
  return { OrgItem: item };
};

/**
 * Why a new write may not name this part, or null for an active catalog item or a pending
 * provisional part of this org. A resolved provisional's GTIN is dead: its stock lives on the real part.
 */
async function partRefusal(orgId: string, gtin13: string): Promise<string | null> {
  const provisional = await db.inventoryProvisionalItem.findFirst({ where: { orgId, provisionalGtin13: gtin13 }, select: { status: true, resolvedToGtin13: true } });
  const id = formatGtinDisplay(gtin13);
  if (provisional?.status === "pending") return null;
  if (provisional?.resolvedToGtin13) return `${id} is now ${formatGtinDisplay(provisional.resolvedToGtin13)}; pick that part instead`;
  if (provisional) return `${id} was rejected by the catalog`;
  return (await catalogHasActiveItem(gtin13)) ? null : `No active catalog item or pending provisional part has GTIN ${id}`;
}

export const create: InventoryRouteHandler = async ({ req }) => {
  const data = await parseBody(req, createSchema);
  const orgId = await getOrgId();
  const refusal = await partRefusal(orgId, data.gtin13);
  if (refusal) throw httpError(400, refusal);
  const principal = await getPrincipal();
  await mapServiceErrors(() =>
    getServices().inventoryService.createItem(orgId, data, principal.id, principal.name ?? undefined),
  );
  return { OrgItem: await findItem(data.gtin13) };
};

export const update: InventoryRouteHandler = async ({ req, params }) => {
  const data = await parseBody(req, updateSchema);
  const orgId = await getOrgId();
  const principal = await getPrincipal();
  await mapServiceErrors(() =>
    getServices().inventoryService.updateItem(orgId, params.gtin13, data, principal.id, principal.name ?? undefined),
  );
  return { OrgItem: await findItem(params.gtin13) };
};

export const remove: InventoryRouteHandler = async ({ params }) => {
  const orgId = await getOrgId();
  const principal = await getPrincipal();
  await mapServiceErrors(() =>
    getServices().inventoryService.deleteItem(orgId, params.gtin13, principal.id, principal.name ?? undefined),
  );
  return {};
};
