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

function auditNote(raisedGtin13: string, currentGtin13: string, proposedGtin13: string): string | undefined {
  if (currentGtin13 === proposedGtin13) return `Raised against ${raisedGtin13}; the part is already on ${proposedGtin13}, so there was nothing left to decide.`;
  if (currentGtin13 !== raisedGtin13) return `Raised against ${raisedGtin13}; decided against ${currentGtin13}, where the part was when resolved.`;
  return undefined;
}

/**
 * Resolves a conflict against `shownExistingGtin13`, the item the reviewer saw.
 * The row keeps the item it was decided against; the audit note keeps the one raised.
 */
export async function resolveConflict(
  conflictId: number,
  userId: number,
  resolution: ConflictResolution,
  shownExistingGtin13: string,
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
    const ref = await createItemReferenceRepository(tx).findByIdForUpdate(conflict.itemReferenceId);
    if (!ref) throw new ServiceError(404, "Conflict not found");

    const { count } = await tx.referenceConflict.updateMany({
      where: { id: conflictId, resolvedAt: null },
      data: { resolvedAt: new Date(), resolution: nextState as ConflictResolution, resolvedByUserId: userId, existingGtin13: ref.gtin13 },
    });
    if (count === 0) throw new ServiceError(409, "Conflict was already resolved");
    if (ref.gtin13 !== shownExistingGtin13) {
      throw new ServiceError(409, "This part moved to another item while the conflict was open. The conflict has been reloaded; please review it again.");
    }

    if (nextState === "use_proposed" && ref.gtin13 !== conflict.proposedGtin13) {
      if (!ref.archivedAt) {
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

    await recordTransition(tx, "reference_conflict", conflictId, currentState, nextState, userId, auditNote(conflict.existingGtin13, ref.gtin13, conflict.proposedGtin13));
  });
}
