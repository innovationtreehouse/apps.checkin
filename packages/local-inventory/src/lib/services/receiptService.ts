import type { Db } from "../db/index";
import type { ProvisionalItem, OrgItem } from "../db/schema";
import type { InventoryRepository } from "../repositories/inventoryRepository";
import type { ProvisionalItemRepository } from "../repositories/provisionalItemRepository";
import type { ReceiveQueueRepository } from "../repositories/receiveQueueRepository";
import type { InventoryService } from "./inventoryService";
import type { ProvisionalItemService } from "./provisionalItemService";

export function createReceiptService({
  inventoryService,
  provisionalItemService,
  inventoryRepo,
  provisionalRepo,
  receiveQueueRepo,
  db,
}: {
  inventoryService: InventoryService;
  provisionalItemService: ProvisionalItemService;
  inventoryRepo: InventoryRepository;
  provisionalRepo: ProvisionalItemRepository;
  receiveQueueRepo: ReceiveQueueRepository;
  db: Db;
}) {
  return {
    async applyReceipt(
      orgId: string,
      receiptId: string,
      retailer: string | undefined,
      lineItems: Array<{
        gtin13: string;
        quantityDelta: number;
        isDelayed?: boolean;
        lineItemId?: number;
        isProvisional?: boolean;
        provisionalName?: string;
        conversionFactor?: number;
        conversionVersion?: number;
      }>,
    ) {
      const updatedItems: Array<{ gtin13: string; newQuantity: number }> = [];

      for (const li of lineItems) {
        if (!li.gtin13) continue;

        if (li.isProvisional) {
          const existing = await provisionalRepo.findByGtin(orgId, li.gtin13);
          if (!existing) {
            await provisionalRepo.create({
              provisionalGtin13: li.gtin13,
              name: li.provisionalName ?? li.gtin13,
              usageBehavior: "Unknown",
              orgId,
              status: "pending",
              proposedAt: new Date(),
              // Remember the factor this provisional's stock was counted under,
              // so a later map-to-existing can detect a unit mismatch.
              conversionFactor: li.conversionFactor ?? 1,
            });
            // Reconcile-on-ingest: if a catalog resolution for this provisional GTIN already
            // arrived (event-before-row), apply it now so the item converges immediately.
            await provisionalItemService.reconcileProvisionalOnCreate(orgId, li.gtin13);
          }
        }

        if (li.isDelayed) {
          await receiveQueueRepo.create({
            orgId,
            gtin13: li.gtin13,
            quantity: li.quantityDelta,
            conversionFactor: li.conversionFactor ?? 1,
            conversionVersion: li.conversionVersion ?? 1,
            retailer: retailer ?? "",
            receiptId,
            lineItemId: li.lineItemId ?? 0,
            queuedAt: new Date(),
          });
          continue;
        }

        const newQty = await inventoryService.applyQtyChange(orgId, li.gtin13, li.quantityDelta, {
          userId: null,
          changeType: "automatic",
          receiptId,
          conversionFactor: li.conversionFactor ?? 1,
          conversionVersion: li.conversionVersion ?? 1,
        });
        updatedItems.push({ gtin13: li.gtin13, newQuantity: newQty });
      }

      return { success: true, updatedItems };
    },

    async getOrgItem(gtin13: string, orgId: string) {
      return inventoryRepo.findOne(orgId, gtin13);
    },

    async createProvisional(
      orgId: string,
      data: {
        provisionalGtin13: string;
        name: string;
        proposedCategoryId?: number;
        proposedSubcategoryId?: number;
        usageBehavior: string;
        proposedByUserId: number;
        receiptId: string;
        conversionFactor?: number;
      },
    ): Promise<{ provisionalItem: ProvisionalItem; orgItem: OrgItem }> {
      const now = new Date();

      const result = await db.$transaction(async (tx) => {
        const provisionalItem = await tx.provisionalItem.create({
          data: {
            provisionalGtin13: data.provisionalGtin13,
            name: data.name,
            proposedCategoryId: data.proposedCategoryId ?? null,
            proposedSubcategoryId: data.proposedSubcategoryId ?? null,
            usageBehavior: data.usageBehavior,
            proposedByUserId: data.proposedByUserId,
            orgId,
            proposedAt: now,
            status: "pending",
            conversionFactor: data.conversionFactor ?? 1,
          },
        });

        const orgItem = await tx.orgItem.create({
          data: { orgId, gtin13: data.provisionalGtin13, existingQuantity: 0, desiredQuantity: 0 },
        });

        await tx.inventoryLog.create({
          data: {
            orgId, userId: null, changedAt: now, changeType: "automatic",
            gtin13: data.provisionalGtin13, fieldChanged: "status",
            valueBefore: null, valueAfter: "pending", receiptId: data.receiptId,
          },
        });

        return { provisionalItem, orgItem };
      });

      // Reconcile-on-ingest (after commit, since it issues its own writes/merge): if a catalog
      // resolution for this provisional GTIN already arrived (event-before-row), apply it now.
      await provisionalItemService.reconcileProvisionalOnCreate(orgId, data.provisionalGtin13);

      return result;
    },

    async enqueueItem(
      orgId: string,
      data: {
        gtin13: string;
        quantity: number;
        retailer?: string;
        receiptId: string;
        lineItemId: number;
        conversionFactor?: number;
        conversionVersion?: number;
      },
    ) {
      return receiveQueueRepo.create({
        orgId,
        gtin13: data.gtin13,
        quantity: data.quantity,
        conversionFactor: data.conversionFactor ?? 1,
        conversionVersion: data.conversionVersion ?? 1,
        retailer: data.retailer ?? "",
        receiptId: data.receiptId,
        lineItemId: data.lineItemId,
        queuedAt: new Date(),
      });
    },
  };
}

export type ReceiptService = ReturnType<typeof createReceiptService>;
