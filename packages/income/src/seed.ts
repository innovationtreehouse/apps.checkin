import { db } from "./db";
import { RECON_KIND, RECON_STATUS } from "./lib/reconcile";

/** Dev seed: one OPEN NO_DEPOSIT row for `orgId` (the host's seeded Org). Idempotent. */
export async function seedIncomeDev(orgId: string): Promise<void> {
  await db.payoutReconciliation.upsert({
    where: { orgId_payoutGid: { orgId, payoutGid: "gid://shopify/ShopifyPaymentsPayout/seed-1" } },
    create: {
      orgId,
      payoutGid: "gid://shopify/ShopifyPaymentsPayout/seed-1",
      payoutDate: "2026-06-01",
      payoutNetCents: 19400,
      status: RECON_STATUS.OPEN,
      kind: RECON_KIND.NO_DEPOSIT,
    },
    update: {},
  });
}
