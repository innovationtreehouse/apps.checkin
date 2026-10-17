/**
 * Catalog audit route factory (#1286). Returns Item + ItemReference model bags;
 * the host stripper ships the internal actor-attribution fields (createdBy*,
 * updatedBy*) to a manager view and public fields to other viewers.
 */
import { createCatalogRepository } from "../repositories/catalog";
import { createItemReferenceRepository } from "../repositories/itemReference";
import { getDb } from "../runtime";
import type { CatalogRouteHandler } from "../contract";

export const get: CatalogRouteHandler = async () => {
  const db = getDb();
  const [items, itemReferences] = await Promise.all([
    createCatalogRepository(db).listItemsForAudit(),
    createItemReferenceRepository(db).listItemReferencesForAudit(),
  ]);
  return { Item: items, ItemReference: itemReferences };
};
