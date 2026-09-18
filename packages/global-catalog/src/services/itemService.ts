import { Prisma } from "@/generated/prisma/client";
import { db, isUniqueConstraintError } from "@/db";
import { createCatalogRepository } from "@/repositories/catalog";
import type { UsageBehavior } from "@/db/schema";

const catalogRepo = createCatalogRepository(db);
import { buildGtin13 } from "@/lib/gtin";
import { ServiceError } from "./categoryService";

type Tx = Prisma.TransactionClient;

export interface CreateItemParams {
  name: string;
  categoryId: number;
  subcategoryId: number;
  usageBehavior: UsageBehavior;
  createdByUserId?: number;
  createdByUsername?: string;
}

export interface ResolvedItemContext {
  name: string;
  categoryId: number;
  subcategoryId: number;
  usageBehavior: UsageBehavior;
  categoryLetter: string;
  subcategoryNumber: number;
}

export interface CreatedItem {
  gtin13: string;
  sequence: number;
}

export async function resolveItemContext(params: CreateItemParams): Promise<ResolvedItemContext> {
  const cat = await catalogRepo.findCategoryById(params.categoryId);
  if (!cat) throw new ServiceError(404, "Category not found");

  const sub = await catalogRepo.findSubcategoryById(params.subcategoryId);
  if (!sub) throw new ServiceError(404, "Subcategory not found");
  if (sub.categoryId !== params.categoryId) throw new ServiceError(400, "Subcategory does not belong to the selected category");

  const duplicate = await catalogRepo.findItemByName(params.name.trim());
  if (duplicate) throw new ServiceError(409, "An item with that name already exists");

  return {
    name: params.name.trim(),
    categoryId: cat.id,
    subcategoryId: sub.id,
    usageBehavior: params.usageBehavior,
    categoryLetter: cat.letter,
    subcategoryNumber: sub.number,
  };
}

export async function allocateAndInsertItem(
  ctx: ResolvedItemContext,
  tx: Tx,
  createdByUserId?: number,
  createdByUsername?: string
): Promise<CreatedItem> {
  const agg = await tx.item.aggregate({
    _max: { sequence: true },
    where: { categoryId: ctx.categoryId, subcategoryId: ctx.subcategoryId },
  });
  const nextSeq = (agg._max.sequence ?? 0) + 1;
  if (nextSeq >= 9999) throw new ServiceError(400, "Sequence number limit reached for this category/subcategory");

  const gtin13 = buildGtin13(ctx.categoryLetter, ctx.subcategoryNumber, nextSeq);
  await tx.item.create({
    data: {
      gtin13,
      name: ctx.name,
      categoryId: ctx.categoryId,
      subcategoryId: ctx.subcategoryId,
      sequence: nextSeq,
      usageBehavior: ctx.usageBehavior,
      createdByUserId: createdByUserId ?? null,
      updatedByUserId: createdByUserId ?? null,
      createdByUsername: createdByUsername ?? null,
      updatedByUsername: createdByUsername ?? null,
    },
  });
  // Note: allocateAndInsertItem uses the transaction client directly for sequence safety

  return { gtin13, sequence: nextSeq };
}

export async function createItem(params: CreateItemParams): Promise<CreatedItem> {
  const ctx = await resolveItemContext(params);
  try {
    return await db.$transaction((tx) => allocateAndInsertItem(ctx, tx, params.createdByUserId, params.createdByUsername));
  } catch (err) {
    if (isUniqueConstraintError(err)) throw new ServiceError(409, "An item with that name or sequence already exists");
    throw err;
  }
}
