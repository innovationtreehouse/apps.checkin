import { describeDb as gate } from "@inventory/pg-test-harness";
import { db } from "../../lib/db/index";

export const describeDb = gate("LOCAL_INVENTORY_DATABASE_URL");

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
