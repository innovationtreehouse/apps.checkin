/**
 * X11: bulk-donation's InventoryApply bound in-process to local-inventory's apply,
 * for in-kind goods entered without a receipt. Apply is idempotent per source
 * (`donation:<id>`); a key replayed with a different delta throws its 409. Only a
 * `donation:` key is accepted, so a donation can never load under a receipt's key.
 */
import { ResolvedInventoryDeltaSchema } from "@checkin/receipt-types";
import { inventoryApply, isProvisionalGtin13 } from "@checkin/local-inventory";
import type { InventoryApply, OrgIdentity } from "@checkin/bulk-donation";

const DONATION_KEY = /^donation:(\d+)$/;

export function createLocalInventoryApply(org: () => Promise<OrgIdentity>): InventoryApply {
  return {
    async apply(input) {
      const delta = ResolvedInventoryDeltaSchema.parse(input);
      const { id: orgId } = await org();
      if (delta.orgId !== orgId) throw new Error("inventory delta orgId does not match this org");
      const donationId = DONATION_KEY.exec(delta.receiptId)?.[1];
      if (!donationId) throw new Error("in-kind inventory loads must be keyed donation:<id>");
      await inventoryApply.applyDonation(
        orgId,
        donationId,
        delta.lineItems.map(({ gtin13, quantityDelta, conversionFactor, conversionVersion, provisionalName }) => ({
          gtin13,
          quantityDelta,
          conversionFactor,
          conversionVersion,
          // A provisional GTIN's stock is tracked so it merges once the catalog resolves it.
          ...(isProvisionalGtin13(gtin13) ? { isProvisional: true, provisionalName: provisionalName ?? gtin13 } : {}),
        })),
      );
    },
  };
}
