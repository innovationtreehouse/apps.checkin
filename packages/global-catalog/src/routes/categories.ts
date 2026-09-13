/**
 * Category route factories (#1286). Thin: parse → repo → model bag. The host's
 * handler() runs admission + the stripper over the returned `{ Category }` bag.
 */
import { z } from "zod";
import { createCatalogRepository } from "../repositories/catalog";
import { getDb, catalogError } from "../runtime";
import type { CatalogRouteHandler } from "../contract";
import { parseId, readJson, parseBody, query } from "./_shared";

const repo = () => createCatalogRepository(getDb());

const bodySchema = z.object({
  name: z.string().min(1),
  letter: z
    .string()
    .regex(/^[A-Z]$/i, "letter must be a single A-Z letter")
    .transform((s) => s.toUpperCase()),
});

export const list: CatalogRouteHandler = async ({ req }) => {
  const includeArchived = query(req).get("includeArchived") === "true";
  return { Category: await repo().listCategories(includeArchived) };
};

export const create: CatalogRouteHandler = async ({ req }) => {
  const { name, letter } = parseBody(bodySchema, await readJson(req));
  const r = repo();
  if (await r.findActiveCategoryByLetter(letter)) {
    throw catalogError(409, "A category with that letter already exists");
  }
  const trimmedName = name.trim();
  if (await r.findActiveCategoryByName(trimmedName)) {
    throw catalogError(409, "A category with that name already exists");
  }
  return { Category: await r.createCategory({ name: trimmedName, letter }) };
};

export const update: CatalogRouteHandler = async ({ req, params }) => {
  const id = parseId(params.id);
  const { name, letter } = parseBody(bodySchema, await readJson(req));
  const r = repo();
  const existing = await r.findCategoryById(id);
  if (!existing) throw catalogError(404, "Category not found");

  if (existing.letter !== letter) {
    if (await r.findItemInCategory(id)) {
      throw catalogError(409, "Cannot change letter: items exist in this category");
    }
    if (await r.findActiveCategoryByLetterExcluding(letter, id)) {
      throw catalogError(409, "A category with that letter already exists");
    }
  }
  const trimmedName = name.trim();
  if (existing.name !== trimmedName && (await r.findActiveCategoryByNameExcluding(trimmedName, id))) {
    throw catalogError(409, "A category with that name already exists");
  }
  return { Category: await r.updateCategory(id, { name: trimmedName, letter }) };
};

export const archive: CatalogRouteHandler = async ({ params }) => {
  const id = parseId(params.id);
  const r = repo();
  const existing = await r.findCategoryById(id);
  if (!existing) throw catalogError(404, "Category not found");
  if (existing.archivedAt) throw catalogError(409, "Category already archived");
  return { Category: await r.updateCategory(id, { archivedAt: new Date() }) };
};

export const unarchive: CatalogRouteHandler = async ({ params }) => {
  const id = parseId(params.id);
  const r = repo();
  const existing = await r.findCategoryById(id);
  if (!existing) throw catalogError(404, "Category not found");
  if (!existing.archivedAt) throw catalogError(409, "Category is not archived");
  if (await r.findActiveCategoryByLetterExcluding(existing.letter, id)) {
    throw catalogError(409, "Cannot unarchive: another active category uses this letter");
  }
  return { Category: await r.updateCategory(id, { archivedAt: null }) };
};
