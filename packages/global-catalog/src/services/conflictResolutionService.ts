import { db } from "../db";
import { createItemReferenceRepository } from "../repositories/itemReference";
import { createCatalogRepository } from "../repositories/catalog";
import type { ConflictResolution, ReferenceConflict } from "../db/schema";

const itemRefRepo = createItemReferenceRepository(db);
const catalogRepo = createCatalogRepository(db);
import type { ConflictResolutionStatus } from "../workflows/conflict-resolution.machine";
import { ServiceError } from "./categoryService";
import { assertConflictResolutionTransition } from "../workflows/conflict-resolution.machine";
import { WorkflowTransitionError } from "@inventory/workflows";
import { recordTransition } from "./orgEventService";

export interface ReportConflictParams {
  itemReferenceId: number;
  existingGtin13: string;
  proposedGtin13: string;
  manufacturer?: string;
  retailer?: string;
  partNumber?: string;
  description?: string;
  receiptId: string;
  lineItemId: number;
}

export async function reportConflict(params: ReportConflictParams): Promise<{ id: number }> {
  const gtins = [params.existingGtin13, params.proposedGtin13];
  const foundItems = await catalogRepo.findItemsByGtins(gtins);
  const foundSet = new Set(foundItems.map((r) => r.gtin13));
  for (const gtin of gtins) {
    if (!foundSet.has(gtin)) throw new ServiceError(400, `GTIN not found: ${gtin}`);
  }

  const row = await itemRefRepo.createReferenceConflict({
    itemReferenceId: params.itemReferenceId,
    existingGtin13: params.existingGtin13,
    proposedGtin13: params.proposedGtin13,
    manufacturer: params.manufacturer ?? null,
    retailer: params.retailer ?? null,
    partNumber: params.partNumber ?? null,
    description: params.description ?? null,
    receiptId: params.receiptId,
    lineItemId: params.lineItemId,
  });

  return { id: row.id };
}

export async function resolveConflict(
  conflictId: number,
  userId: number,
  resolution: ConflictResolution
): Promise<void> {
  const conflict = await itemRefRepo.findConflictById(conflictId);
  if (!conflict) throw new ServiceError(404, "Conflict not found");
  const currentState = conflict.resolvedAt ? (conflict.resolution as ConflictResolutionStatus) : ("open" as ConflictResolutionStatus);
  let nextState: ConflictResolutionStatus;
  try {
    nextState = assertConflictResolutionTransition(currentState, { type: "RESOLVE", resolution });
  } catch (err) {
    if (err instanceof WorkflowTransitionError) throw new ServiceError(400, err.message);
    throw err;
  }

  await db.$transaction(async (tx) => {
    if (nextState === "use_proposed") {
      await tx.itemReference.update({
        where: { id: conflict.itemReferenceId },
        data: { gtin13: conflict.proposedGtin13 },
      });
    }

    await tx.referenceConflict.update({
      where: { id: conflictId },
      data: { resolvedAt: new Date(), resolution: nextState as ConflictResolution, resolvedByUserId: userId },
    });

    await recordTransition(tx, "reference_conflict", conflictId, currentState, nextState, userId);
  });
}
