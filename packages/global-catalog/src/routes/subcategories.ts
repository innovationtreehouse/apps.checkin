/** Subcategory route factories (#1286). */
import { z } from "zod";
import type { Prisma } from "../generated/prisma/client";
import { createCatalogRepository } from "../repositories/catalog";
import { getDb, catalogError } from "../runtime";
import type { CatalogRouteHandler } from "../contract";
import { parseId, readJson, parseBody, query } from "./_shared";

const repo = () => createCatalogRepository(getDb());

const createSchema = z.object({
  name: z.string().min(1),
  number: z.number().int().min(1).max(99),
  categoryId: z.number().int().positive(),
});
const updateSchema = z.object({ name: z.string().min(1) });

export const list: CatalogRouteHandler = async ({ req }) => {
  const sp = query(req);
  const includeArchived = sp.get("includeArchived") === "true";
  const categoryIdStr = sp.get("categoryId");
  const categoryId = categoryIdStr ? parseId(categoryIdStr, "categoryId") : undefined;

  const archivedFilter: Prisma.SubcategoryWhereInput = includeArchived ? {} : { archivedAt: null };
  const where = categoryId !== undefined ? { ...archivedFilter, categoryId } : archivedFilter;
  return { Subcategory: await repo().listSubcategories(where) };
};

export const create: CatalogRouteHandler = async ({ req }) => {
  const { name, number, categoryId } = parseBody(createSchema, await readJson(req));
  const r = repo();
  if (!(await r.findCategoryById(categoryId))) throw catalogError(404, "Category not found");
  if (await r.findActiveSubcategoryByNumber(number, categoryId)) {
    throw catalogError(409, "A subcategory with that number already exists in this category");
  }
  const trimmedName = name.trim();
  if (await r.findActiveSubcategoryByName(trimmedName, categoryId)) {
    throw catalogError(409, "A subcategory with that name already exists in this category");
  }
  return { Subcategory: await r.createSubcategory({ name: trimmedName, number, categoryId }) };
};

export const update: CatalogRouteHandler = async ({ req, params }) => {
  const id = parseId(params.id);
  const { name } = parseBody(updateSchema, await readJson(req));
  const r = repo();
  const existing = await r.findSubcategoryById(id);
  if (!existing) throw catalogError(404, "Subcategory not found");
  if (await r.findItemInSubcategory(id)) {
    throw catalogError(409, "Cannot rename: items exist in this subcategory");
  }
  const trimmedName = name.trim();
  if (
    trimmedName !== existing.name &&
    (await r.findActiveSubcategoryByNameExcluding(trimmedName, existing.categoryId, id))
  ) {
    throw catalogError(409, "A subcategory with that name already exists in this category");
  }
  return { Subcategory: await r.updateSubcategory(id, { name: trimmedName }) };
};

export const archive: CatalogRouteHandler = async ({ params }) => {
  const id = parseId(params.id);
  const r = repo();
  const existing = await r.findSubcategoryById(id);
  if (!existing) throw catalogError(404, "Subcategory not found");
  if (existing.archivedAt) throw catalogError(409, "Subcategory already archived");
  return { Subcategory: await r.updateSubcategory(id, { archivedAt: new Date() }) };
};

export const unarchive: CatalogRouteHandler = async ({ params }) => {
  const id = parseId(params.id);
  const r = repo();
  const existing = await r.findSubcategoryById(id);
  if (!existing) throw catalogError(404, "Subcategory not found");
  if (!existing.archivedAt) throw catalogError(409, "Subcategory is not archived");
  if (await r.findActiveSubcategoryByNumberExcluding(existing.number, existing.categoryId, id)) {
    throw catalogError(409, "Cannot unarchive: another active subcategory uses this number in the category");
  }
  if (await r.findActiveSubcategoryByNameExcluding(existing.name, existing.categoryId, id)) {
    throw catalogError(409, "Cannot unarchive: another active subcategory uses this name in the category");
  }
  return { Subcategory: await r.updateSubcategory(id, { archivedAt: null }) };
};
