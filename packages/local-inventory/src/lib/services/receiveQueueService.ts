import type { ReceiveQueueRepository } from "../repositories/receiveQueueRepository";
import type { ProvisionalItemRepository } from "../repositories/provisionalItemRepository";
import type { InventoryService } from "./inventoryService";
import { ServiceError } from "./serviceError";

export function createReceiveQueueService({
  receiveQueueRepo,
  provisionalRepo,
  inventoryService,
}: {
  receiveQueueRepo: ReceiveQueueRepository;
  provisionalRepo: ProvisionalItemRepository;
  inventoryService: InventoryService;
}) {
  return {
    async listQueue(orgId: string, includeFulfilled = false) {
      const rows = await receiveQueueRepo.findManyByOrg(orgId);
      return includeFulfilled ? rows : rows.filter((r) => r.fulfilledAt === null);
    },

    async fulfill(id: number, orgId: string, userId: number) {
      const item = await receiveQueueRepo.findOne(id, orgId);
      if (!item) throw new ServiceError(404, "Receive queue item not found");
      if (item.fulfilledAt) throw new ServiceError(409, "Already fulfilled");

      const updated = await receiveQueueRepo.markFulfilled(id);

      // If the queued GTIN13 was provisional and has since been resolved to a real
      // GTIN13 by the global catalog, apply the quantity to the real GTIN13.
      const provisional = await provisionalRepo.findByGtin(orgId, item.gtin13);
      const effectiveGtin = provisional?.resolvedToGtin13 ?? item.gtin13;

      await inventoryService.applyQtyChange(orgId, effectiveGtin, item.quantity, {
        userId,
        changeType: "received",
        receiptId: item.receiptId,
        // Apply the factor the line was queued under (units per receipt unit).
        conversionFactor: item.conversionFactor,
        conversionVersion: item.conversionVersion,
      });

      return updated;
    },

    async cancel(id: number, orgId: string) {
      const item = await receiveQueueRepo.findOne(id, orgId);
      if (!item) throw new ServiceError(404, "Receive queue item not found");
      if (item.fulfilledAt) throw new ServiceError(409, "Cannot delete a fulfilled item");
      await receiveQueueRepo.delete(id);
    },
  };
}

export type ReceiveQueueService = ReturnType<typeof createReceiveQueueService>;
