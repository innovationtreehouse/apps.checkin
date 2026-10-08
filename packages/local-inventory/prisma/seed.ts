/**
 * Local-inventory dev/test seed (#1287 §12). Writes a baseline the screens and
 * flow tests exercise without the receipt pipeline: one location, one queued
 * receipt line, and one pending uom_mismatch merge conflict with the provisional
 * and real org items behind it. Idempotent, so a re-run is safe.
 */
import * as dotenv from "dotenv";
import { getPrisma } from "../src/lib/db";

dotenv.config();

// The org id the host injects (checkin's single-org accessor); rows stamped
// with any other id are invisible to the routes.
const ORG_ID = "treehouse";
const PROVISIONAL_GTIN = "2000000000022";
const REAL_GTIN = "0012345678905";

async function main(): Promise<void> {
  // Fixture rows must never reach a live inventory; only the local/flow env seeds.
  if (process.env.CHECKIN_ENV !== "local") {
    throw new Error(`Refusing to seed local inventory: CHECKIN_ENV is "${process.env.CHECKIN_ENV ?? ""}", not "local".`);
  }
  if (!process.env.LOCAL_INVENTORY_DATABASE_URL) {
    throw new Error("LOCAL_INVENTORY_DATABASE_URL is not set — the local-inventory seed needs a database.");
  }
  const db = getPrisma();

  if (!(await db.location.findFirst({ where: { orgId: ORG_ID, name: "Shelf A" } }))) {
    await db.location.create({ data: { orgId: ORG_ID, name: "Shelf A" } });
  }

  if (!(await db.receiveQueue.findFirst({ where: { orgId: ORG_ID, receiptId: "seed-receipt-1" } }))) {
    await db.receiveQueue.create({
      data: { orgId: ORG_ID, gtin13: "0098765432109", quantity: 3, retailer: "Seed Supply", receiptId: "seed-receipt-1", lineItemId: 1 },
    });
  }

  for (const [gtin13, existingQuantity] of [[PROVISIONAL_GTIN, 4], [REAL_GTIN, 10]] as const) {
    await db.orgItem.upsert({
      where: { orgGtin: { orgId: ORG_ID, gtin13 } },
      create: { orgId: ORG_ID, gtin13, existingQuantity, desiredQuantity: 0 },
      update: {},
    });
  }
  await db.inventoryProvisionalItem.upsert({
    where: { provisionalGtin13: PROVISIONAL_GTIN },
    create: {
      provisionalGtin13: PROVISIONAL_GTIN, name: "Seed bolt pack", usageBehavior: "Consumable", orgId: ORG_ID,
      status: "approved", reviewedAt: new Date(), resolvedToGtin13: REAL_GTIN,
    },
    update: {},
  });
  await db.inventoryMergeConflict.upsert({
    where: { sourceEventId: 1 },
    create: {
      orgId: ORG_ID, provisionalGtin13: PROVISIONAL_GTIN, realGtin13: REAL_GTIN, conflictType: "uom_mismatch",
      provisionalConversionFactor: 1, existingConversionFactor: 12, sourceEventId: 1,
    },
    update: {},
  });

  console.log("🌱 Local-inventory seed complete: 1 location, 1 queued line, 1 pending merge conflict.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await getPrisma().$disconnect();
  });
