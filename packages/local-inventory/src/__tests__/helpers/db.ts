import { describe } from "vitest";
import { db } from "../../lib/db/index";

/**
 * DB-gate for the integration tier. `describeDb` is `describe` when LOCAL_INVENTORY_DATABASE_URL
 * is set (the harness publishes the container URL in test/setupEnv.ts) and `describe.skip`
 * otherwise — so route-handler suites that need a real Postgres run against the throwaway
 * container when Docker is up, and cleanly skip (not fail) on a machine without Docker.
 */
export const describeDb = process.env.LOCAL_INVENTORY_DATABASE_URL ? describe : describe.skip;

// Delete all data in FK-safe order (children before parents).
// Using deleteMany avoids raw SQL and works regardless of connection pool behavior.
export async function resetDb(): Promise<void> {
  await db.provisionalItemLog.deleteMany({});
  await db.inventoryMergeConflict.deleteMany({});
  await db.inventoryLog.deleteMany({});
  await db.locationLog.deleteMany({});
  await db.receiveQueue.deleteMany({});
  await db.inventoryReceivedOrgEvent.deleteMany({});
  await db.receivedInventoryDelta.deleteMany({});
  await db.inventoryProvisionalResolution.deleteMany({});
  await db.inventoryProvisionalItem.deleteMany({});
  await db.orgItem.deleteMany({});
  await db.location.deleteMany({});
}
