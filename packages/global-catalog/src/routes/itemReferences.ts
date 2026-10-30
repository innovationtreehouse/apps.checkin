/** Item-reference route factories (#1286). Returns ItemReference model bags. */
import { httpError, mapServiceErrors, parseBody, parseId, query } from "@checkin/component-kit";
import { z } from "zod";
import type { ItemReference, Prisma } from "../generated/prisma/client";
import { createItemReferenceRepository, type ItemReferenceRepository } from "../repositories/itemReference";
import { createCatalogRepository } from "../repositories/catalog";
import { assertNoReferenceConflict, type RefFields } from "../services/referenceMatchingService";
import { normalizeDescription } from "../lib/normalizeDescription";
import { getDb, getPrincipal } from "../runtime";
import type { CatalogRouteHandler } from "../contract";

const refRepo = () => createItemReferenceRepository(getDb());
const catalogRepo = () => createCatalogRepository(getDb());

/** Runs a write on one reference with its row locked, so `existing` stays current through the conflict check. */
const withLockedReference = <T>(
  id: number,
  fn: (tx: Prisma.TransactionClient, repo: ItemReferenceRepository, existing: ItemReference) => Promise<T>,
) =>
  mapServiceErrors(() =>
    getDb().$transaction(async (tx) => {
      const repo = createItemReferenceRepository(tx);
      const existing = await repo.findByIdForUpdate(id);
      if (!existing) throw httpError(404, "Reference not found");
      return fn(tx, repo, existing);
    }),
  );

const optionalTrimmed = z
  .string()
  .optional()
  .transform((v) => v?.trim() || null);

const httpUrl = optionalTrimmed.pipe(z.url({ protocol: /^https?$/, error: "url must be an http(s) link" }).nullable());

const createSchema = z
  .object({
    gtin13: z.string().min(1, "gtin13 is required"),
    partNumber: optionalTrimmed,
    description: optionalTrimmed,
    manufacturer: optionalTrimmed,
    retailer: optionalTrimmed,
    url: httpUrl,
  })
  .refine((b) => Boolean(b.partNumber || b.description || b.manufacturer || b.retailer || b.url), {
    message: "At least one of partNumber, description, manufacturer, retailer, or url is required",
  });

// Same shape as create minus the (immutable) gtin13. Validates + trims the body
// so a wrong-typed field is a 400, not a 500 at `.trim()`.
const updateSchema = z
  .object({
    partNumber: optionalTrimmed,
    description: optionalTrimmed,
    manufacturer: optionalTrimmed,
    retailer: optionalTrimmed,
    url: httpUrl,
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
  const body = await parseBody(req, createSchema);
  const fields: RefFields = {
    partNumber: body.partNumber,
    description: body.description,
    manufacturer: body.manufacturer,
    retailer: body.retailer,
  };
  if (!(await catalogRepo().findItemByGtin13(body.gtin13))) throw httpError(404, "Item not found");

  const principal = await getPrincipal();
  const now = new Date();
  const created = await mapServiceErrors(() =>
    getDb().$transaction(async (tx) => {
      await assertNoReferenceConflict(tx, body.gtin13, fields);
      return createItemReferenceRepository(tx).createItemReference({
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
    }),
  );
  return { ItemReference: created };
};

export const update: CatalogRouteHandler = async ({ req, params }) => {
  const id = parseId(params.id);
  const body = await parseBody(req, updateSchema);
  const fields: RefFields = {
    partNumber: body.partNumber,
    description: body.description,
    manufacturer: body.manufacturer,
    retailer: body.retailer,
  };

  const principal = await getPrincipal();
  const updated = await withLockedReference(id, async (tx, repo, existing) => {
    await assertNoReferenceConflict(tx, existing.gtin13, fields);
    return repo.updateItemReference(id, {
      partNumber: fields.partNumber,
      descriptionNormalized: body.description ? normalizeDescription(body.description) : null,
      manufacturer: fields.manufacturer,
      retailer: fields.retailer,
      url: body.url,
      updatedAt: new Date(),
      updatedByUserId: principal.id,
      updatedByUsername: principal.name,
    });
  });
  return { ItemReference: updated };
};

export const archive: CatalogRouteHandler = async ({ params }) => {
  const id = parseId(params.id);
  const r = refRepo();
  const existing = await r.findById(id);
  if (!existing) throw httpError(404, "Reference not found");
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
  const principal = await getPrincipal();
  return {
    ItemReference: await withLockedReference(id, async (tx, repo, existing) => {
      await assertNoReferenceConflict(tx, existing.gtin13, {
        partNumber: existing.partNumber,
        manufacturer: existing.manufacturer,
        description: existing.descriptionNormalized,
        retailer: existing.retailer,
      });
      return repo.updateItemReference(id, {
        archivedAt: null,
        updatedAt: new Date(),
        updatedByUserId: principal.id,
        updatedByUsername: principal.name,
      });
    }),
  };
};
