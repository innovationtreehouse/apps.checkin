import { describe } from "vitest";
import { db, initDb } from "@/lib/db/index";

/**
 * DB-gate for the integration tier. `describeDb` is `describe` when LOCAL_INVENTORY_DATABASE_URL
 * is set (the harness publishes the container URL in test/setupEnv.ts) and `describe.skip`
 * otherwise — so route-handler suites that need a real Postgres run against the throwaway
 * container when Docker is up, and cleanly skip (not fail) on a machine without Docker.
 */
export const describeDb = process.env.LOCAL_INVENTORY_DATABASE_URL ? describe : describe.skip;

// Delete all data in FK-safe order (children before parents), then re-seed.
// Using deleteMany avoids raw SQL and works regardless of connection pool behavior.
export async function resetDb(): Promise<void> {
  // Ensure schema is ready before we try to delete from it
  await initDb();

  await db.provisionalItemLog.deleteMany({});
  await db.inventoryMergeConflict.deleteMany({});
  await db.inventoryLog.deleteMany({});
  await db.locationLog.deleteMany({});
  await db.receiveQueue.deleteMany({});
  await db.receivedOrgEvent.deleteMany({});
  await db.receivedInventoryDelta.deleteMany({});
  await db.provisionalResolution.deleteMany({});
  await db.provisionalItem.deleteMany({});
  await db.orgItem.deleteMany({});
  await db.location.deleteMany({});
  // Reset settings to defaults without deleting the row (avoids AUTOINCREMENT id reuse issue)
  await db.settingsData.update({
    where: { id: 1 },
    data: { globalServerUrl: null, pollIntervalMinutes: 3, pollWindowStart: "00:00", pollWindowEnd: "23:59" },
  });
}
