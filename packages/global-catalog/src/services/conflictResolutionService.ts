import { db } from "../db";
import { createItemReferenceRepository } from "../repositories/itemReference";
import { createCatalogRepository } from "../repositories/catalog";
import type { ConflictResolution } from "../db/schema";

const itemRefRepo = createItemReferenceRepository(db);
const catalogRepo = createCatalogRepository(db);
import type { ConflictResolutionStatus } from "../workflows/conflict-resolution.machine";
import { ServiceError } from "@checkin/component-kit";
import { reviewTransitionError } from "./categoryService";
import { assertConflictResolutionTransition } from "../workflows/conflict-resolution.machine";
import { recordTransition } from "./orgEventService";
import { assertNoReferenceConflict } from "./referenceMatchingService";

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
    throw reviewTransitionError(err, currentState !== "open", "Conflict was already resolved");
  }

  await db.$transaction(async (tx) => {
    const { count } = await tx.referenceConflict.updateMany({
      where: { id: conflictId, resolvedAt: null },
      data: { resolvedAt: new Date(), resolution: nextState as ConflictResolution, resolvedByUserId: userId },
    });
    if (count === 0) throw new ServiceError(409, "Conflict was already resolved");

    if (nextState === "use_proposed") {
      const ref = await createItemReferenceRepository(tx).findByIdForUpdate(conflict.itemReferenceId);
      if (ref && !ref.archivedAt) {
        await assertNoReferenceConflict(
          tx,
          conflict.proposedGtin13,
          { partNumber: ref.partNumber, manufacturer: ref.manufacturer, retailer: ref.retailer, description: ref.descriptionNormalized },
          ref.id,
        );
      }
      await tx.itemReference.update({
        where: { id: conflict.itemReferenceId },
        data: { gtin13: conflict.proposedGtin13 },
      });
    }

    await recordTransition(tx, "reference_conflict", conflictId, currentState, nextState, userId);
  });
}
