/** Item-reference route factories (#1286). Returns ItemReference model bags. */
import { z } from "zod";
import type { Prisma } from "../generated/prisma/client";
import { createItemReferenceRepository } from "../repositories/itemReference";
import { createCatalogRepository } from "../repositories/catalog";
import { findAutoConflict, type RefFields } from "../services/referenceMatchingService";
import { normalizeDescription } from "../lib/normalizeDescription";
import { getDb, getPrincipal, catalogError } from "../runtime";
import type { CatalogRouteHandler } from "../contract";
import { parseId, readJson, parseBody, query } from "./_shared";

const refRepo = () => createItemReferenceRepository(getDb());
const catalogRepo = () => createCatalogRepository(getDb());

const optionalTrimmed = z
  .string()
  .optional()
  .transform((v) => v?.trim() || null);

const createSchema = z
  .object({
    gtin13: z.string().min(1, "gtin13 is required"),
    partNumber: optionalTrimmed,
    description: optionalTrimmed,
    manufacturer: optionalTrimmed,
    retailer: optionalTrimmed,
    url: optionalTrimmed,
  })
  .refine((b) => Boolean(b.partNumber || b.description || b.manufacturer || b.retailer || b.url), {
    message: "At least one of partNumber, description, manufacturer, retailer, or url is required",
  });

export const list: CatalogRouteHandler = async ({ req }) => {
  const sp = query(req);
  const gtin13 = sp.get("gtin13");
  if (gtin13) return { ItemReference: await refRepo().listByGtin13(gtin13) };

  const page = Math.max(1, Number.parseInt(sp.get("page") ?? "1", 10) || 1);
  const limit = Math.min(200, Math.max(1, Number.parseInt(sp.get("limit") ?? "50", 10) || 50));
  const showArchived = sp.get("showArchived") === "true";
  const q = sp.get("q")?.trim() ?? "";
  const sortByParam = sp.get("sortBy");
  const col = sortByParam === "retailer" ? "retailer" : sortByParam === "item" ? "item" : "manufacturer";
  const sortDir: Prisma.SortOrder = sp.get("sortDir") === "desc" ? "desc" : "asc";

  const where: Prisma.ItemReferenceWhereInput = {};
  if (!showArchived) where.archivedAt = null;
  if (q) {
    where.OR = [
      { manufacturer: { contains: q } },
      { retailer: { contains: q } },
      { partNumber: { contains: q } },
      { descriptionNormalized: { contains: q } },
      { item: { name: { contains: q } } },
      { gtin13: { contains: q } },
    ];
  }
  const orderBy: Prisma.ItemReferenceOrderByWithRelationInput[] =
    col === "item"
      ? [{ item: { name: sortDir } }, { id: "asc" }]
      : col === "retailer"
        ? [{ retailer: sortDir }, { id: "asc" }]
        : [{ manufacturer: sortDir }, { id: "asc" }];

  const { rows } = await refRepo().listPaginated({ where, orderBy, page, limit });
  return { ItemReference: rows };
};

export const create: CatalogRouteHandler = async ({ req }) => {
  const body = parseBody(createSchema, await readJson(req));
  const fields: RefFields = {
    partNumber: body.partNumber,
    description: body.description,
    manufacturer: body.manufacturer,
    retailer: body.retailer,
  };
  if (!(await catalogRepo().findItemByGtin13(body.gtin13))) throw catalogError(404, "Item not found");
  const conflict = await findAutoConflict(body.gtin13, fields);
  if (conflict) throw catalogError(409, conflict);

  const principal = await getPrincipal();
  const now = new Date();
  const created = await refRepo().createItemReference({
    gtin13: body.gtin13,
    partNumber: fields.partNumber,
    descriptionNormalized: body.description ? normalizeDescription(body.description) : null,
    manufacturer: fields.manufacturer,
    retailer: fields.retailer,
    url: body.url,
    conversionFactor: 1.0,
    conversionVersion: 1,
    createdAt: now,
    updatedAt: now,
    createdByUserId: principal.id,
    updatedByUserId: principal.id,
    createdByUsername: principal.name,
    updatedByUsername: principal.name,
  });
  return { ItemReference: created };
};

export const update: CatalogRouteHandler = async ({ req, params }) => {
  const id = parseId(params.id);
  const r = refRepo();
  const existing = await r.findById(id);
  if (!existing) throw catalogError(404, "Reference not found");

  const body = (await readJson(req)) as {
    partNumber?: string;
    manufacturer?: string;
    description?: string;
    retailer?: string;
    url?: string;
  };
  const rawDescription = body.description?.trim() || null;
  const fields: RefFields = {
    partNumber: body.partNumber?.trim() || null,
    description: rawDescription,
    manufacturer: body.manufacturer?.trim() || null,
    retailer: body.retailer?.trim() || null,
  };
  if (!fields.partNumber && !fields.description && !fields.manufacturer && !fields.retailer && !body.url?.trim()) {
    throw catalogError(400, "At least one of partNumber, description, manufacturer, retailer, or url is required");
  }
  const conflict = await findAutoConflict(existing.gtin13, fields);
  if (conflict) throw catalogError(409, conflict);

  const principal = await getPrincipal();
  const updated = await r.updateItemReference(id, {
    partNumber: fields.partNumber,
    descriptionNormalized: rawDescription ? normalizeDescription(rawDescription) : null,
    manufacturer: fields.manufacturer,
    retailer: fields.retailer,
    url: body.url?.trim() || null,
    updatedAt: new Date(),
    updatedByUserId: principal.id,
    updatedByUsername: principal.name,
  });
  return { ItemReference: updated };
};

export const archive: CatalogRouteHandler = async ({ params }) => {
  const id = parseId(params.id);
  const r = refRepo();
  const existing = await r.findById(id);
  if (!existing) throw catalogError(404, "Reference not found");
  const principal = await getPrincipal();
  return {
    ItemReference: await r.updateItemReference(id, {
      archivedAt: new Date(),
      updatedAt: new Date(),
      updatedByUserId: principal.id,
      updatedByUsername: principal.name,
    }),
  };
};

export const unarchive: CatalogRouteHandler = async ({ params }) => {
  const id = parseId(params.id);
  const r = refRepo();
  const existing = await r.findById(id);
  if (!existing) throw catalogError(404, "Reference not found");
  const conflict = await findAutoConflict(existing.gtin13, {
    partNumber: existing.partNumber,
    manufacturer: existing.manufacturer,
    description: existing.descriptionNormalized,
    retailer: existing.retailer,
  });
  if (conflict) throw catalogError(409, conflict);
  const principal = await getPrincipal();
  return {
    ItemReference: await r.updateItemReference(id, {
      archivedAt: null,
      updatedAt: new Date(),
      updatedByUserId: principal.id,
      updatedByUsername: principal.name,
    }),
  };
};
