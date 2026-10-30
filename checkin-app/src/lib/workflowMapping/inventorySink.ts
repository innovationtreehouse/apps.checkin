/**
 * X4: workflow-mapping's InventorySink bound in-process to
 * local-inventory's apply. Apply is idempotent per source (`receipt:<receiptId>`),
 * and a key replayed with a different delta throws its 409; that error is left
 * to propagate so the receipt's inventory leg lands in apply_failed.
 */
import { ResolvedInventoryDeltaSchema } from "@checkin/receipt-types";
import type { InventorySink, OrgIdentity } from "@checkin/workflow-mapping";
import { inventoryApply } from "@checkin/local-inventory";

export function createLocalInventorySink(org: () => Promise<OrgIdentity>): InventorySink {
  return {
    async applyDelta(input) {
      const delta = ResolvedInventoryDeltaSchema.parse(input);
      const { id: orgId } = await org();
      if (delta.orgId !== orgId) throw new Error("inventory delta orgId does not match this org");
      await inventoryApply.applyReceipt(orgId, delta.receiptId, delta.retailer ?? undefined, delta.lineItems);
    },
  };
}
