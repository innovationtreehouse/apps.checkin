/**
 * X4 (#1289 §8c): workflow-mapping's InventorySink bound in-process to
 * local-inventory's apply. Apply is idempotent per source (`receipt:<receiptId>`),
 * and a key replayed with a different delta throws its 409; that error is left
 * to propagate so the receipt's inventory leg lands in apply_failed.
 */
import { ResolvedInventoryDeltaSchema } from "@inventory/receipt-types";
import type { InventorySink, OrgIdentity } from "@inventory/workflow-mapping";
import {
  createInventoryRepository,
  createProvisionalItemRepository,
  createProvisionalItemService,
  createProvisionalResolutionRepository,
  createReceiptService,
  createReceiveQueueRepository,
  db as inventoryDb,
  type ReceiptService,
} from "@inventory/local-inventory";

let receiptService: ReceiptService | undefined;

function inventoryReceipts(): ReceiptService {
  if (receiptService) return receiptService;
  const inventoryRepo = createInventoryRepository(inventoryDb);
  receiptService = createReceiptService({
    provisionalItemService: createProvisionalItemService({
      provisionalRepo: createProvisionalItemRepository(inventoryDb),
      resolutionRepo: createProvisionalResolutionRepository(inventoryDb),
      inventoryRepo,
      db: inventoryDb,
    }),
    inventoryRepo,
    receiveQueueRepo: createReceiveQueueRepository(inventoryDb),
    db: inventoryDb,
  });
  return receiptService;
}

export function createLocalInventorySink(org: () => Promise<OrgIdentity>): InventorySink {
  return {
    async applyDelta(input) {
      const delta = ResolvedInventoryDeltaSchema.parse(input);
      const { id: orgId } = await org();
      if (delta.orgId !== orgId) throw new Error("inventory delta orgId does not match this org");
      await inventoryReceipts().applyReceipt(orgId, delta.receiptId, delta.retailer ?? undefined, delta.lineItems);
    },
  };
}
