import { afterEach, beforeEach } from "vitest";
import { db } from "../db";
import { configureExpense } from "../runtime";
import { ORG } from "./helpers/seed";

// Every test starts from the inert ports; a test rebinds what it needs.
beforeEach(() => configureExpense({ org: () => ({ id: ORG, name: "Org One" }) }));

afterEach(async () => {
  // A Docker-less run (DB suites skipped) never connects just to clean up.
  if (!process.env.EXPENSE_DATABASE_URL) return;
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
