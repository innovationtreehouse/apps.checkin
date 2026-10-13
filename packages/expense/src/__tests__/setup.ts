import { afterEach, beforeEach, expect } from "vitest";
import { db } from "../db";
import { configureExpense } from "../runtime";
import { ORG, TEST_BUCKETS } from "./helpers/seed";

// Every test starts from the inert ports plus the test buckets; a test rebinds what it needs.
beforeEach(() => configureExpense({ org: async () => ({ id: ORG, name: "Org One" }), budgetOwners: TEST_BUCKETS }));

afterEach(async () => {
  // Only the integration tier touches the database; a Docker-less run never connects to clean up.
  if (!process.env.EXPENSE_DATABASE_URL || !expect.getState().testPath?.includes("/integration/")) return;
  // Children before parents (holds and audit rows restrict their expense and line).
  await db.expenseAuditLog.deleteMany();
  await db.expenseHold.deleteMany();
  await db.expenseEvent.deleteMany();
  await db.expense.deleteMany();
  await db.accountMapping.deleteMany();
  await db.expenseOrgSettings.deleteMany();
  await db.expenseOrgSettingsChange.deleteMany();
  await db.partOwnerMap.deleteMany();
  await db.provisionalItemMap.deleteMany();
  await db.expenseProvisionalResolution.deleteMany();
  await db.receivedExpensePayload.deleteMany();
  await db.expenseReceivedOrgEvent.deleteMany();
  await db.expenseQbAccount.deleteMany();
  await db.capitalAsset.deleteMany();
  await db.expenseQbMatchExclusion.deleteMany();
});
