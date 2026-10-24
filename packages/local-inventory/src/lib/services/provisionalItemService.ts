import type { Prisma } from "../../generated/prisma/client";
import type { Db } from "../db/index";
import type { ProvisionalItemRepository } from "../repositories/provisionalItemRepository";
import type { ProvisionalResolutionRepository } from "../repositories/provisionalResolutionRepository";
import type { InventoryRepository } from "../repositories/inventoryRepository";
import { ServiceError } from "@checkin/component-kit";
import {
  assertProvisionalTransition,
  assertMergeConflictTransition,
  WorkflowTransitionError,
} from "../../workflows/index";
import type { ProvisionalItemStatus, MergeConflictStatus } from "../db/schema";

/**
 * Lock both org-item rows (in GTIN order, so two lockers never deadlock on each other) and
 * read them under the lock, so a concurrent stock add waits for this transaction to commit.
 */
export async function lockOrgItemPair(tx: Prisma.TransactionClient, orgId: string, provisionalGtin13: string, realGtin13: string) {
  await tx.$queryRaw`SELECT id FROM org_items WHERE org_id = ${orgId} AND gtin13 IN (${provisionalGtin13}, ${realGtin13}) ORDER BY gtin13 FOR UPDATE`;
  const [provisionalRow, existingRow] = await Promise.all([
    tx.orgItem.findFirst({ where: { orgId, gtin13: provisionalGtin13 } }),
    tx.orgItem.findFirst({ where: { orgId, gtin13: realGtin13 } }),
  ]);
  return { provisionalRow, existingRow };
}

/**
 * Lock the provisional's own row and read it under the lock. Merges and fulfils take it before
 * the org-item pair, so they serialize even when neither GTIN has an org-item row yet.
 */
export async function lockProvisional(tx: Prisma.TransactionClient, orgId: string, provisionalGtin13: string) {
  await tx.$queryRaw`SELECT id FROM provisional_items WHERE org_id = ${orgId} AND provisional_gtin13 = ${provisionalGtin13} FOR UPDATE`;
  return tx.inventoryProvisionalItem.findFirst({ where: { orgId, provisionalGtin13 } });
}

export function createProvisionalItemService({
  provisionalRepo,
  resolutionRepo,
  inventoryRepo,
  db,
}: {
  provisionalRepo: ProvisionalItemRepository;
  resolutionRepo: ProvisionalResolutionRepository;
  inventoryRepo: InventoryRepository;
  db: Db;
}) {
  async function mergeOrgItems(
    orgId: string,
    provisionalGtin13: string,
    realGtin13: string,
    provisionalId: number,
    finalStatus: ProvisionalItemStatus,
    sourceEventId: number,
    // Factor the provisional's stock was counted under vs. the resolved real
    // item's canonical factor (from the S5 event). When they differ the two
    // quantities are not directly summable → park a uom_mismatch conflict.
    provisionalConversionFactor: number,
    existingConversionFactor: number,
  ): Promise<void> {
    const now = new Date();
    await db.$transaction(async (tx) => {
      await lockProvisional(tx, orgId, provisionalGtin13);
      const { provisionalRow, existingRow } = await lockOrgItemPair(tx, orgId, provisionalGtin13, realGtin13);
      // The caller read the status outside this transaction; a concurrent merge that already
      // resolved the provisional wins, and this one does nothing.
      const claimed = await tx.inventoryProvisionalItem.updateMany({
        where: { id: provisionalId, status: "pending" },
        data: { status: finalStatus, resolvedToGtin13: realGtin13, reviewedAt: now },
      });
      if (claimed.count === 0) return;

      // The org holds none of the real item, so the provisional's received count carries over
      // with no factor check. A missing real row is unlocked, so a first receipt on the real
      // GTIN can insert it concurrently; upserting on the (orgId, gtin13) index folds that
      // receipt into the same row instead of colliding with it.
      if (!existingRow || existingRow.existingQuantity === 0) {
        const provisionalQty = provisionalRow?.existingQuantity ?? 0;
        let realQty = provisionalQty;
        if (provisionalRow) {
          ({ existingQuantity: realQty } = await tx.orgItem.upsert({
            where: { orgGtin: { orgId, gtin13: realGtin13 } },
            create: {
              orgId, gtin13: realGtin13, existingQuantity: provisionalQty,
              desiredQuantity: provisionalRow.desiredQuantity,
              locationId: provisionalRow.locationId,
              backstockLocationId: provisionalRow.backstockLocationId,
            },
            update: { existingQuantity: { increment: provisionalQty } },
          }));
          await tx.orgItem.delete({ where: { orgGtin: { orgId, gtin13: provisionalGtin13 } } });
        }
        await tx.inventoryLog.create({
          data: realQty === provisionalQty
            ? {
              orgId, userId: null, changedAt: now, changeType: "automatic",
              gtin13: realGtin13, fieldChanged: "gtin13",
              valueBefore: provisionalGtin13, valueAfter: realGtin13, receiptId: null,
            }
            : {
              orgId, userId: null, changedAt: now, changeType: "automatic",
              gtin13: realGtin13, fieldChanged: "existingQuantity",
              valueBefore: String(realQty - provisionalQty), valueAfter: String(realQty), receiptId: null,
            },
        });
        await tx.provisionalItemLog.create({
          data: {
            orgId, provisionalItemId: provisionalId, gtin13: provisionalGtin13,
            eventType: finalStatus, notes: `renamed to ${realGtin13}`,
            performedBy: null, createdAt: now,
          },
        });
        return;
      }

      // Units actually differ → the human-counted provisional total and the
      // existing real total assume different pack sizes; blind-summing would
      // corrupt stock. Park the decision for a human instead.
      if (provisionalConversionFactor !== existingConversionFactor) {
        const conflictType = "uom_mismatch";
        await tx.inventoryMergeConflict.upsert({
          where: { sourceEventId },
          create: {
            orgId, provisionalGtin13, realGtin13, conflictType,
            provisionalConversionFactor,
            existingConversionFactor,
            status: "pending",
            sourceEventId,
          },
          update: {},
        });
        await tx.provisionalItemLog.create({
          data: {
            orgId, provisionalItemId: provisionalId, gtin13: provisionalGtin13,
            eventType: "conflict_created", notes: conflictType,
            performedBy: null, createdAt: now,
          },
        });
        return;
      }

      const newQty = (provisionalRow?.existingQuantity ?? 0) + existingRow.existingQuantity;
      await tx.orgItem.update({
        where: { orgGtin: { orgId, gtin13: realGtin13 } },
        data: { existingQuantity: newQty },
      });
      if (provisionalRow) {
        await tx.orgItem.delete({ where: { orgGtin: { orgId, gtin13: provisionalGtin13 } } });
      }
      await tx.inventoryLog.create({
        data: {
          orgId, userId: null, changedAt: now, changeType: "automatic",
          gtin13: realGtin13, fieldChanged: "existingQuantity",
          valueBefore: String(existingRow.existingQuantity), valueAfter: String(newQty), receiptId: null,
        },
      });
      await tx.provisionalItemLog.create({
        data: {
          orgId, provisionalItemId: provisionalId, gtin13: provisionalGtin13,
          eventType: finalStatus, notes: `merged into ${realGtin13}, qty: ${newQty}`,
          performedBy: null, createdAt: now,
        },
      });
    });
  }

  const service = {
    async listProvisionals(orgId: string) {
      return provisionalRepo.findManyByOrg(orgId);
    },

    /**
     * Apply a previously-recorded catalog resolution to a provisional row that has just been
     * created (reconcile-on-ingest). Fixes the event-before-row ordering: when the S5
     * resolution arrived before this consumer had a provisional row, approve/map/reject
     * persisted a durable InventoryProvisionalResolution and no-op'd the apply. Once the row exists,
     * call this to apply it now — passing the STORED sourceEventId so the merge-conflict
     * upsert stays keyed on the original event. Idempotent: the status early-returns inside
     * approve/map/reject guard against double-apply, and a missing resolution is a no-op.
     */
    async reconcileProvisionalOnCreate(orgId: string, provisionalGtin13: string): Promise<void> {
      const resolution = await resolutionRepo.findByGtin(orgId, provisionalGtin13);
      if (!resolution) return; // nothing recorded yet — no-op

      // Prefer the stored sourceEventId (the merge-conflict upsert is keyed on it); fall back
      // to 0 only if it was never recorded (non-event-bearing resolution).
      const sourceEventId = resolution.sourceEventId ?? 0;

      // The event's own factor, so a later merge compares real units rather than a default.
      const realConversionFactor = resolution.conversionFactor ?? undefined;

      if (resolution.kind === "approved" && resolution.realGtin13) {
        await service.approveProvisional(orgId, provisionalGtin13, resolution.realGtin13, sourceEventId, realConversionFactor);
      } else if (resolution.kind === "mapped_to_existing" && resolution.realGtin13) {
        await service.mapProvisionalToExisting(orgId, provisionalGtin13, resolution.realGtin13, sourceEventId, realConversionFactor);
      } else if (resolution.kind === "rejected") {
        await service.rejectProvisional(orgId, provisionalGtin13, resolution.rejectionReason ?? undefined);
      }
    },

    async approveProvisional(
      orgId: string,
      provisionalGtin13: string,
      realGtin13: string,
      sourceEventId: number,
      // Canonical factor of the resolved real item (from the S5 event). For
      // approve-new the provisional simply renames (no existing stock), so this
      // only matters for the symmetric map-to-existing path. Absent means "each" (1).
      realConversionFactor?: number,
    ): Promise<void> {
      // 1) Durably record the resolution FIRST, so a row that arrives later can be
      // reconciled (reconcileProvisionalOnCreate). Idempotent; tolerates P2002.
      await resolutionRepo.upsert(orgId, provisionalGtin13, {
        kind: "approved",
        realGtin13,
        sourceEventId,
        conversionFactor: realConversionFactor ?? null,
      });

      const provisional = await provisionalRepo.findByGtin(orgId, provisionalGtin13);
      // Benign no-op when no provisional row exists yet: the resolution is persisted and
      // will be applied by reconcileProvisionalOnCreate when the row is created. A
      // non-inventory provisional may legitimately never reach this consumer, so this
      // must be harmless-if-unclaimed (do NOT throw).
      if (!provisional) return;
      if (provisional.status === "approved") return;
      let nextStatus: ProvisionalItemStatus;
      try { nextStatus = assertProvisionalTransition(provisional.status as ProvisionalItemStatus, "APPROVE"); }
      catch (err) {
        if (err instanceof WorkflowTransitionError) throw new ServiceError(409, err.message);
        throw err;
      }
      await mergeOrgItems(orgId, provisionalGtin13, realGtin13, provisional.id, nextStatus, sourceEventId, provisional.conversionFactor, realConversionFactor ?? 1);
    },

    async rejectProvisional(
      orgId: string,
      provisionalGtin13: string,
      rejectionReason?: string,
    ): Promise<void> {
      // Durably record the resolution FIRST (see approveProvisional).
      await resolutionRepo.upsert(orgId, provisionalGtin13, {
        kind: "rejected",
        rejectionReason: rejectionReason ?? null,
      });

      const provisional = await provisionalRepo.findByGtin(orgId, provisionalGtin13);
      if (!provisional) return; // benign no-op; reconcile applies on create
      if (provisional.status === "rejected") return;
      let nextStatus: ProvisionalItemStatus;
      try { nextStatus = assertProvisionalTransition(provisional.status as ProvisionalItemStatus, "REJECT"); }
      catch (err) {
        if (err instanceof WorkflowTransitionError) throw new ServiceError(409, err.message);
        throw err;
      }

      const now = new Date();
      await db.$transaction(async (tx) => {
        await tx.inventoryProvisionalItem.update({
          where: { id: provisional.id },
          data: { status: nextStatus, rejectionReason: rejectionReason ?? null, reviewedAt: now },
        });
        await tx.provisionalItemLog.create({
          data: {
            orgId, provisionalItemId: provisional.id, gtin13: provisionalGtin13,
            eventType: nextStatus, notes: rejectionReason ?? null,
            performedBy: null, createdAt: now,
          },
        });
      });
    },

    async mapProvisionalToExisting(
      orgId: string,
      provisionalGtin13: string,
      realGtin13: string,
      sourceEventId: number,
      // Canonical factor of the existing real item (from the S5 event). Absent means "each" (1).
      realConversionFactor?: number,
    ): Promise<void> {
      // Durably record the resolution FIRST (see approveProvisional).
      await resolutionRepo.upsert(orgId, provisionalGtin13, {
        kind: "mapped_to_existing",
        realGtin13,
        sourceEventId,
        conversionFactor: realConversionFactor ?? null,
      });

      const provisional = await provisionalRepo.findByGtin(orgId, provisionalGtin13);
      if (!provisional) return; // benign no-op; reconcile applies on create
      if (provisional.status === "mapped_to_existing") return;
      let nextStatus: ProvisionalItemStatus;
      try { nextStatus = assertProvisionalTransition(provisional.status as ProvisionalItemStatus, "MAP_TO_EXISTING"); }
      catch (err) {
        if (err instanceof WorkflowTransitionError) throw new ServiceError(409, err.message);
        throw err;
      }
      await mergeOrgItems(orgId, provisionalGtin13, realGtin13, provisional.id, nextStatus, sourceEventId, provisional.conversionFactor, realConversionFactor ?? 1);
    },

    async listConflicts(orgId: string) {
      const conflicts = await provisionalRepo.findConflictsByOrg(orgId);
      return Promise.all(
        conflicts.map(async (c) => {
          const [provisionalOrgItem, realOrgItem] = await Promise.all([
            inventoryRepo.findOne(orgId, c.provisionalGtin13),
            inventoryRepo.findOne(orgId, c.realGtin13),
          ]);
          return { ...c, provisionalOrgItem: provisionalOrgItem ?? null, realOrgItem: realOrgItem ?? null };
        }),
      );
    },

    async resolveConflict(
      conflictId: number,
      orgId: string,
      resolution: { quantityMethod: "use_provisional" | "use_existing" | "sum" },
      userId: number,
      username?: string,
    ) {
      const conflict = await provisionalRepo.findConflict(conflictId, orgId);
      if (!conflict) throw new ServiceError(404, "Conflict not found");
      let nextConflictStatus: MergeConflictStatus;
      try { nextConflictStatus = assertMergeConflictTransition(conflict.status as MergeConflictStatus, "RESOLVE"); }
      catch (err) {
        if (err instanceof WorkflowTransitionError) throw new ServiceError(400, "Conflict is already resolved");
        throw err;
      }

      const now = new Date();
      const resolutionJson = await db.$transaction(async (tx) => {
        const { provisionalRow, existingRow: realRow } = await lockOrgItemPair(
          tx, orgId, conflict.provisionalGtin13, conflict.realGtin13,
        );
        if (!realRow) throw new ServiceError(400, "Real GTIN org item not found");

        const provisionalQty = provisionalRow?.existingQuantity ?? 0;
        const existingQty = realRow.existingQuantity;

        let finalQuantity: number;
        if (resolution.quantityMethod === "use_provisional") finalQuantity = provisionalQty;
        else if (resolution.quantityMethod === "use_existing") finalQuantity = existingQty;
        else finalQuantity = provisionalQty + existingQty;
        const json = JSON.stringify({ finalQuantity, method: resolution.quantityMethod });

        // Conditional on the status read above, so two concurrent resolves apply once.
        const closed = await tx.inventoryMergeConflict.updateMany({
          where: { id: conflictId, status: conflict.status },
          data: { status: nextConflictStatus, resolvedByUserId: userId, resolvedAt: now, resolution: json },
        });
        if (closed.count === 0) throw new ServiceError(400, "Conflict is already resolved");

        await tx.orgItem.update({
          where: { orgGtin: { orgId, gtin13: conflict.realGtin13 } },
          data: { existingQuantity: finalQuantity },
        });

        if (provisionalRow) {
          await tx.orgItem.delete({
            where: { orgGtin: { orgId, gtin13: conflict.provisionalGtin13 } },
          });
        }

        await tx.inventoryLog.create({
          data: {
            orgId, userId, username: username ?? null, changedAt: now, changeType: "manual",
            gtin13: conflict.realGtin13, fieldChanged: "existingQuantity",
            valueBefore: String(existingQty), valueAfter: String(finalQuantity), receiptId: null,
          },
        });

        await tx.provisionalItemLog.create({
          data: {
            orgId, provisionalItemId: null, gtin13: conflict.provisionalGtin13,
            eventType: "conflict_resolved", notes: json,
            performedBy: userId, performedByUsername: username ?? null, createdAt: now,
          },
        });
        return json;
      });

      return { success: true, resolution: resolutionJson };
    },
  };

  return service;
}

export type ProvisionalItemService = ReturnType<typeof createProvisionalItemService>;
