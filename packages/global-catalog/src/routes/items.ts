/**
 * Item route factories (#1286). Returns Item rows WITH their category /
 * subcategory relations (the host stripper recurses them); the source's
 * flattened shape is dropped — clients read `item.category.name`. Server-side
 * pagination meta (total/pages) is not carried in the model bag; the list UI +
 * a count endpoint land in track 5.
 */
import { z } from "zod";
import type { Prisma } from "../generated/prisma/client";
import { createCatalogRepository } from "../repositories/catalog";
import { usageBehaviorEnum } from "../db/schema";
import { createItem } from "../services/itemService";
import { getDb, getPrincipal, catalogError, mapServiceErrors } from "../runtime";
import type { CatalogRouteHandler } from "../contract";
import { parseBody, readJson, query } from "./_shared";

const repo = () => createCatalogRepository(getDb());

const createSchema = z.object({
  name: z.string().trim().min(1),
  categoryId: z.number().int().positive(),
  subcategoryId: z.number().int().positive(),
  usageBehavior: z.enum(usageBehaviorEnum),
});
const updateSchema = z
  .object({
    name: z.string().trim().min(1),
    usageBehavior: z.enum(usageBehaviorEnum).optional(),
  })
  .strict();

export const list: CatalogRouteHandler = async ({ req }) => {
  const sp = query(req);
  const includeArchived = sp.get("includeArchived") === "true";
  const page = Math.max(1, Number.parseInt(sp.get("page") ?? "1", 10) || 1);
  const limit = Math.min(200, Math.max(1, Number.parseInt(sp.get("limit") ?? "50", 10) || 50));
  const q = sp.get("q")?.trim() ?? "";
  const sortByParam = sp.get("sortBy");
  const sortBy = sortByParam === "id" || sortByParam === "category" ? sortByParam : "name";
  const sortDir: Prisma.SortOrder = sp.get("sortDir") === "desc" ? "desc" : "asc";

  const where: Prisma.ItemWhereInput = {};
  if (!includeArchived) where.archivedAt = null;
  if (q) {
    where.OR = [
      { name: { contains: q } },
      { gtin13: { contains: q } },
      { category: { name: { contains: q } } },
      { subcategory: { name: { contains: q } } },
    ];
  }
  const orderBy: Prisma.ItemOrderByWithRelationInput[] =
    sortBy === "id"
      ? [{ gtin13: sortDir }]
      : sortBy === "category"
        ? [{ category: { name: sortDir } }, { subcategory: { name: sortDir } }, { name: sortDir }]
        : [{ name: sortDir }];

  const { rows } = await repo().listItemsPaginated({ where, orderBy, page, limit });
  return { Item: rows };
};

export const get: CatalogRouteHandler = async ({ params }) => {
  const item = await repo().findItemByGtin13WithIncludes(params.gtin13);
  if (!item) throw catalogError(404, "Item not found");
  return { Item: item };
};

export const create: CatalogRouteHandler = async ({ req }) => {
  const parsed = parseBody(createSchema, await readJson(req));
  const principal = await getPrincipal();
  const created = await mapServiceErrors(() =>
    createItem({ ...parsed, createdByUserId: principal.id, createdByUsername: principal.name ?? undefined }),
  );
  const item = await repo().findItemByGtin13WithIncludes(created.gtin13);
  return { Item: item };
};

export const update: CatalogRouteHandler = async ({ req, params }) => {
  const { gtin13 } = params;
  const r = repo();
  if (!(await r.findItemByGtin13(gtin13))) throw catalogError(404, "Item not found");
  const { name, usageBehavior } = parseBody(updateSchema, await readJson(req));
  if (await r.findItemByNameExcluding(name.trim(), gtin13)) {
    throw catalogError(409, "An item with that name already exists");
  }
  const principal = await getPrincipal();
  await r.updateItem(gtin13, {
    name: name.trim(),
    ...(usageBehavior ? { usageBehavior } : {}),
    updatedAt: new Date(),
    updatedByUserId: principal.id,
    updatedByUsername: principal.name,
  });
  return { Item: await r.findItemByGtin13WithIncludes(gtin13) };
};

async function setArchived(gtin13: string, archivedAt: Date | null, wantArchived: boolean) {
  const r = repo();
  const existing = await r.findItemByGtin13(gtin13);
  if (!existing) throw catalogError(404, "Item not found");
  if (wantArchived && existing.archivedAt) throw catalogError(409, "Item is already archived");
  if (!wantArchived && !existing.archivedAt) throw catalogError(409, "Item is not archived");
  const principal = await getPrincipal();
  await r.updateItem(gtin13, {
    archivedAt,
    updatedAt: new Date(),
    updatedByUserId: principal.id,
    updatedByUsername: principal.name,
  });
  return { Item: await r.findItemByGtin13WithIncludes(gtin13) };
}

export const archive: CatalogRouteHandler = ({ params }) => setArchived(params.gtin13, new Date(), true);
export const unarchive: CatalogRouteHandler = ({ params }) => setArchived(params.gtin13, null, false);
