import { ServiceError } from "@checkin/component-kit";
import { WorkflowTransitionError } from "@checkin/workflows";
import { db } from "../db";
import { createCatalogRepository } from "../repositories/catalog";

const catalogRepo = createCatalogRepository(db);

/**
 * Maps a refused review transition to a ServiceError. A refusal from an already
 * reviewed (final) state means another reviewer won the race: 409, the same
 * status a lost in-transaction claim returns.
 */
export function reviewTransitionError(err: unknown, alreadyReviewed: boolean, conflictMessage: string): unknown {
  if (!(err instanceof WorkflowTransitionError)) return err;
  return alreadyReviewed ? new ServiceError(409, conflictMessage) : new ServiceError(400, err.message);
}

export type ResolvedCategory = { id: number; letter: string };
export type ResolvedSubcategory = { id: number; number: number };

export async function resolveOrCreateCategory(opts: {
  categoryId?: number;
  categoryName?: string;
  categoryLetter?: string;
  proposedCategoryId?: number | null;
}): Promise<ResolvedCategory> {
  const { categoryId, categoryName, categoryLetter, proposedCategoryId } = opts;

  if (categoryId !== undefined) {
    const cat = await catalogRepo.findCategoryById(categoryId);
    if (!cat) throw new ServiceError(404, "Category not found");
    return { id: cat.id, letter: cat.letter };
  }

  if (categoryName && categoryLetter) {
    const existing = await catalogRepo.findCategoryByName(categoryName);
    if (existing) throw new ServiceError(409, `Category name '${categoryName}' already exists`);
    const letterExists = await catalogRepo.findCategoryByLetter(categoryLetter.toUpperCase());
    if (letterExists) throw new ServiceError(409, `Category letter '${categoryLetter}' already in use`);
    const newCat = await catalogRepo.createCategory({ name: categoryName, letter: categoryLetter.toUpperCase() });
    return { id: newCat.id, letter: newCat.letter };
  }

  if (proposedCategoryId !== null && proposedCategoryId !== undefined) {
    const cat = await catalogRepo.findCategoryById(proposedCategoryId);
    if (!cat) throw new ServiceError(400, "Proposed category no longer exists. Please specify a category.");
    return { id: cat.id, letter: cat.letter };
  }

  throw new ServiceError(400, "A category must be specified (categoryId or categoryName + categoryLetter)");
}

export async function resolveOrCreateSubcategory(opts: {
  subcategoryId?: number;
  subcategoryName?: string;
  subcategoryNumber?: number;
  proposedSubcategoryId?: number | null;
  categoryId: number;
}): Promise<ResolvedSubcategory> {
  const { subcategoryId, subcategoryName, subcategoryNumber, proposedSubcategoryId, categoryId } = opts;

  if (subcategoryId !== undefined) {
    const sub = await catalogRepo.findSubcategoryById(subcategoryId);
    if (!sub) throw new ServiceError(404, "Subcategory not found");
    if (sub.categoryId !== categoryId) throw new ServiceError(400, "Subcategory does not belong to the specified category");
    return { id: sub.id, number: sub.number };
  }

  if (subcategoryName && subcategoryNumber !== undefined) {
    const nameConflict = await catalogRepo.findActiveSubcategoryByName(subcategoryName, categoryId);
    if (nameConflict) throw new ServiceError(409, `Subcategory name '${subcategoryName}' already exists in this category`);
    const numberConflict = await catalogRepo.findActiveSubcategoryByNumber(subcategoryNumber, categoryId);
    if (numberConflict) throw new ServiceError(409, `Subcategory number ${subcategoryNumber} already in use in this category`);
    const newSub = await catalogRepo.createSubcategory({ name: subcategoryName, number: subcategoryNumber, categoryId });
    return { id: newSub.id, number: newSub.number };
  }

  if (proposedSubcategoryId !== null && proposedSubcategoryId !== undefined) {
    const sub = await catalogRepo.findSubcategoryById(proposedSubcategoryId);
    if (!sub) throw new ServiceError(400, "Proposed subcategory no longer exists. Please specify a subcategory.");
    return { id: sub.id, number: sub.number };
  }

  throw new ServiceError(400, "A subcategory must be specified (subcategoryId or subcategoryName + subcategoryNumber)");
}
