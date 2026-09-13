import type { Db } from "../db/index";
import type { ProvisionalItemRepository } from "../repositories/provisionalItemRepository";
import type { ProvisionalResolutionRepository } from "../repositories/provisionalResolutionRepository";
import type { InventoryRepository } from "../repositories/inventoryRepository";
import { ServiceError } from "./serviceError";
import {
  assertProvisionalTransition,
  assertMergeConflictTransition,
  WorkflowTransitionError,
} from "../../workflows/index";
import type { ProvisionalItemStatus, MergeConflictStatus } from "../db/schema";

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
    const [provisionalRow, existingRow] = await Promise.all([
      inventoryRepo.findOne(orgId, provisionalGtin13),
      inventoryRepo.findOne(orgId, realGtin13),
    ]);

    const now = new Date();

    if (!existingRow) {
      await db.$transaction(async (tx) => {
        if (provisionalRow) {
          await tx.orgItem.update({
            where: { orgGtin: { orgId, gtin13: provisionalGtin13 } },
            data: { gtin13: realGtin13 },
          });
        }
        await tx.provisionalItem.update({
          where: { id: provisionalId },
          data: { status: finalStatus, resolvedToGtin13: realGtin13, reviewedAt: now },
        });
        await tx.inventoryLog.create({
          data: {
            orgId, userId: null, changedAt: now, changeType: "automatic",
            gtin13: realGtin13, fieldChanged: "gtin13",
            valueBefore: provisionalGtin13, valueAfter: realGtin13, receiptId: null,
          },
        });
        await tx.provisionalItemLog.create({
          data: {
            orgId, provisionalItemId: provisionalId, gtin13: provisionalGtin13,
            eventType: finalStatus, notes: `renamed to ${realGtin13}`,
            performedBy: null, createdAt: now,
          },
        });
      });
      return;
    }

    // Units actually differ → the human-counted provisional total and the
    // existing real total assume different pack sizes; blind-summing would
    // corrupt stock. Park the decision for a human instead.
    const uomConflict = provisionalConversionFactor !== existingConversionFactor;

    if (uomConflict) {
      const conflictType = "uom_mismatch";

      await db.$transaction(async (tx) => {
        await tx.provisionalItem.update({
          where: { id: provisionalId },
          data: { status: finalStatus, resolvedToGtin13: realGtin13, reviewedAt: now },
        });
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
      });
      return;
    }

    const newQty = (provisionalRow?.existingQuantity ?? 0) + existingRow.existingQuantity;

    await db.$transaction(async (tx) => {
      await tx.orgItem.update({
        where: { orgGtin: { orgId, gtin13: realGtin13 } },
        data: { existingQuantity: newQty },
      });
      if (provisionalRow) {
        await tx.orgItem.delete({ where: { orgGtin: { orgId, gtin13: provisionalGtin13 } } });
      }
      await tx.provisionalItem.update({
        where: { id: provisionalId },
        data: { status: finalStatus, resolvedToGtin13: realGtin13, reviewedAt: now },
      });
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
     * persisted a durable ProvisionalResolution and no-op'd the apply. Once the row exists,
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

      if (resolution.kind === "approved" && resolution.realGtin13) {
        await service.approveProvisional(orgId, provisionalGtin13, resolution.realGtin13, sourceEventId);
      } else if (resolution.kind === "mapped_to_existing" && resolution.realGtin13) {
        await service.mapProvisionalToExisting(orgId, provisionalGtin13, resolution.realGtin13, sourceEventId);
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
      // only matters for the symmetric map-to-existing path.
      realConversionFactor = 1,
    ): Promise<void> {
      // 1) Durably record the resolution FIRST, so a row that arrives later can be
      // reconciled (reconcileProvisionalOnCreate). Idempotent; tolerates P2002.
      await resolutionRepo.upsert(orgId, provisionalGtin13, {
        kind: "approved",
        realGtin13,
        sourceEventId,
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
      await mergeOrgItems(orgId, provisionalGtin13, realGtin13, provisional.id, nextStatus, sourceEventId, provisional.conversionFactor, realConversionFactor);
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
        await tx.provisionalItem.update({
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
      // Canonical factor of the existing real item (from the S5 event).
      realConversionFactor = 1,
    ): Promise<void> {
      // Durably record the resolution FIRST (see approveProvisional).
      await resolutionRepo.upsert(orgId, provisionalGtin13, {
        kind: "mapped_to_existing",
        realGtin13,
        sourceEventId,
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
      await mergeOrgItems(orgId, provisionalGtin13, realGtin13, provisional.id, nextStatus, sourceEventId, provisional.conversionFactor, realConversionFactor);
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

      const [provisionalRow, realRow] = await Promise.all([
        inventoryRepo.findOne(orgId, conflict.provisionalGtin13),
        inventoryRepo.findOne(orgId, conflict.realGtin13),
      ]);

      if (!realRow) throw new ServiceError(400, "Real GTIN org item not found");

      const provisionalQty = provisionalRow?.existingQuantity ?? 0;
      const existingQty = realRow.existingQuantity;

      let finalQuantity: number;
      if (resolution.quantityMethod === "use_provisional") finalQuantity = provisionalQty;
      else if (resolution.quantityMethod === "use_existing") finalQuantity = existingQty;
      else finalQuantity = provisionalQty + existingQty;

      const now = new Date();
      const resolutionJson = JSON.stringify({ finalQuantity, method: resolution.quantityMethod });

      await db.$transaction(async (tx) => {
        await tx.orgItem.update({
          where: { orgGtin: { orgId, gtin13: conflict.realGtin13 } },
          data: { existingQuantity: finalQuantity },
        });

        if (provisionalRow) {
          await tx.orgItem.delete({
            where: { orgGtin: { orgId, gtin13: conflict.provisionalGtin13 } },
          });
        }

        await tx.inventoryMergeConflict.update({
          where: { id: conflictId },
          data: { status: nextConflictStatus, resolvedByUserId: userId, resolvedAt: now, resolution: resolutionJson },
        });

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
            eventType: "conflict_resolved", notes: resolutionJson,
            performedBy: userId, performedByUsername: username ?? null, createdAt: now,
          },
        });
      });

      return { success: true, resolution: resolutionJson };
    },
  };

  return service;
}

export type ProvisionalItemService = ReturnType<typeof createProvisionalItemService>;
