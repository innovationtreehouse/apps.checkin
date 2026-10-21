/**
 * Each FINANCE write writes one audit row attributed to the caller: per-expense writes to
 * expense_audit_log, org-level config writes to org_audit_log.
 */
import { beforeEach, expect, it } from "vitest";
import { describeDb } from "../helpers/db";
import { bindPorts, principal, seedExpense, seedLineItem, ORG } from "../helpers/seed";
import { db } from "../../db";
import { expenses, finance } from "../../routes";
import { resubmitHeldExpense, setHeldLineAccount } from "../../services/holdService";
import { seedCapitalAssets } from "../../services/capitalService";
import { excludeQbTxn } from "../../services/qbMatchService";
import type { ExpenseRouteHandler } from "../../contract";

const FINANCE = principal(3, { isFinance: true });
const ACTOR = { actorUserId: 3, actorUsername: "person-3" };

function call(route: ExpenseRouteHandler, method: string, params: Record<string, string> = {}, body?: unknown) {
  const req = new Request("http://test/api/expense", body === undefined ? { method } : { method, body: JSON.stringify(body) });
  return route({ req, params });
}

async function onlyOrgAudit() {
  const rows = await db.expenseOrgAuditLog.findMany();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ orgId: ORG, ...ACTOR });
  return rows[0];
}

/** Runs `write`, then returns the single org audit row it added. */
async function auditOf(write: () => Promise<unknown>) {
  await db.expenseOrgAuditLog.deleteMany();
  await write();
  return onlyOrgAudit();
}

const mapping = { category: "Hardware", subcategory: "Cables", partNumber: "*", isDelayed: null, isCapital: null, qbAccount: "5000" };

describeDb("FINANCE writes are audited", () => {
  beforeEach(() => bindPorts({ auth: { getPrincipal: async () => FINANCE } }));

  it("setting a held line's account records hold_account_set with before and after", async () => {
    const id = await seedExpense({ state: "qb_on_hold" });
    const li = await seedLineItem(id, { manualQbAccount: "4000" });

    await setHeldLineAccount(FINANCE, id, li, "5000");

    const rows = await db.expenseAuditLog.findMany({ where: { expenseId: id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: 3, username: "person-3", action: "hold_account_set", lineItemId: li, valueBefore: "4000", valueAfter: "5000" });
  });

  it("marking test data records test_data_set for each flip; an unchanged value writes nothing", async () => {
    const id = await seedExpense();

    const res = await call(expenses.testData, "PUT", { id }, { isTestData: true });
    expect((res as { Expense: { isTestData: boolean } }).Expense.isTestData).toBe(true);
    await call(expenses.testData, "PUT", { id }, { isTestData: true });
    await call(expenses.testData, "PUT", { id }, { isTestData: false });

    const rows = await db.expenseAuditLog.findMany({ where: { expenseId: id }, orderBy: { id: "asc" } });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ userId: 3, username: "person-3", action: "test_data_set", fieldChanged: "isTestData", valueBefore: "false", valueAfter: "true" });
    expect(rows[1]).toMatchObject({ action: "test_data_set", valueBefore: "true", valueAfter: "false" });
  });

  it("marking test data answers 409 once the expense is in the outbox or past its first QuickBooks state", async () => {
    const queued = await seedExpense();
    await db.expenseEvent.create({ data: { orgId: ORG, expenseId: queued, payload: "{}" } });
    const matched = await seedExpense();
    await db.expense.update({ where: { id: matched }, data: { qbMatchState: "NOT_TEST_DATA" } });
    const lineMatched = await seedExpense();
    await seedLineItem(lineMatched);
    await db.expenseLineItem.updateMany({ where: { expenseId: lineMatched }, data: { qbMatchState: "MATCHED" } });

    for (const id of [queued, matched, lineMatched]) {
      await expect(call(expenses.testData, "PUT", { id }, { isTestData: true })).rejects.toMatchObject({ status: 409 });
    }
    expect(await db.expense.count({ where: { id: { in: [queued, matched, lineMatched] }, isTestData: true } })).toBe(0);
    expect(await db.expenseAuditLog.count({ where: { action: "test_data_set" } })).toBe(0);
  });

  it("marking test data is FINANCE only", async () => {
    const id = await seedExpense();
    bindPorts({ auth: { getPrincipal: async () => principal(4, { isBoard: true }) } });

    await expect(call(expenses.testData, "PUT", { id }, { isTestData: true })).rejects.toMatchObject({ status: 403 });
    expect(await db.expense.findUniqueOrThrow({ where: { id } })).toMatchObject({ isTestData: false });
  });

  it("resubmitting a held expense records hold_resubmitted for the caller", async () => {
    const id = await seedExpense({ state: "qb_on_hold" });

    await resubmitHeldExpense(FINANCE, id);

    const rows = await db.expenseAuditLog.findMany({ where: { expenseId: id, userId: 3 } });
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("hold_resubmitted");
  });

  it("account mapping create, update and delete each record one row", async () => {
    const created = await auditOf(() => call(finance.createAccountMapping, "POST", {}, mapping));
    expect(created).toMatchObject({ entityType: "account_mapping", action: "created", before: null });
    const id = created.entityId!;

    const updated = await auditOf(() => call(finance.updateAccountMapping, "PUT", { id }, { ...mapping, qbAccount: "6000" }));
    expect(updated).toMatchObject({ entityType: "account_mapping", entityId: id, action: "updated" });
    expect(JSON.parse(updated.before!).qbAccount).toBe("5000");
    expect(JSON.parse(updated.after!).qbAccount).toBe("6000");

    const deleted = await auditOf(() => call(finance.deleteAccountMapping, "DELETE", { id }));
    expect(deleted).toMatchObject({ entityType: "account_mapping", entityId: id, action: "deleted", after: null });
  });

  it("QuickBooks account create, update and delete each record one row", async () => {
    const created = await auditOf(() => call(finance.createQbAccount, "POST", {}, { name: "Supplies", qbAccount: "5100" }));
    expect(created).toMatchObject({ entityType: "qb_account", action: "created" });
    const id = created.entityId!;

    const updated = await auditOf(() => call(finance.updateQbAccount, "PUT", { id }, { name: "Supplies", qbAccount: "5200" }));
    expect(updated).toMatchObject({ entityType: "qb_account", entityId: id, action: "updated" });

    const deleted = await auditOf(() => call(finance.deleteQbAccount, "DELETE", { id }));
    expect(deleted).toMatchObject({ entityType: "qb_account", entityId: id, action: "deleted" });
  });

  it("setting a part's owner records the previous and new bucket", async () => {
    const gtin13 = "0000000000017";
    await auditOf(() => call(finance.setOwnership, "PUT", {}, { gtin13, ownerId: 100 }));
    const row = await auditOf(() => call(finance.setOwnership, "PUT", {}, { gtin13, ownerId: 101 }));
    expect(row).toMatchObject({ entityType: "part_owner", entityId: gtin13, action: "owner_set" });
    expect(JSON.parse(row.before!)).toEqual({ ownerId: 100 });
    expect(JSON.parse(row.after!)).toEqual({ ownerId: 101 });
  });

  it("the capital seed records one row per created asset and none for a skipped one", async () => {
    await seedCapitalAssets(FINANCE, [{ assetNumber: "ITFA0001", description: "Lathe" }]);
    const rows = await db.expenseOrgAuditLog.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entityType: "capital_asset", action: "seeded", ...ACTOR });

    await seedCapitalAssets(FINANCE, [{ assetNumber: "ITFA0001", description: "Lathe" }]);
    expect(await db.expenseOrgAuditLog.count()).toBe(1);
  });

  it("excluding a QuickBooks entry records its id and reason; a repeat answers 409 and writes nothing", async () => {
    const row = await auditOf(() => excludeQbTxn(FINANCE, "qb-9", "  hand-booked, no receipt "));
    expect(row).toMatchObject({ entityType: "qb_txn", entityId: "qb-9", action: "excluded", before: null });
    expect(JSON.parse(row.after!)).toEqual({ reason: "hand-booked, no receipt" });

    await expect(excludeQbTxn(FINANCE, "qb-9", "again")).rejects.toMatchObject({ status: 409 });
    expect(await db.expenseOrgAuditLog.count()).toBe(1);
  });
});
