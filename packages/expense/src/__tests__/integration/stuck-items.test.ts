/** The Problems list's ports: failed payloads, catalog events and QuickBooks posts, each timed by its first failure, and their retry. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fixture } from "@checkin/receipt-contract-fixtures";
import { db } from "../../db";
import { receiveCompletedReceipt } from "../../services/intakeService";
import { retryStuckItem, stuckItems } from "../../stuckItems";
import { describeDb } from "../helpers/db";
import { bindPorts, directory, ORG, seedExpense } from "../helpers/seed";

beforeEach(() => bindPorts({}));
afterEach(() => vi.restoreAllMocks());

describeDb("stuckItems", () => {
  it("lists each stuck item with its page, timed by its first failure", async () => {
    const at = new Date("2026-11-01T10:00:00Z");
    const first = new Date("2026-11-02T10:00:00Z");
    await db.receivedExpensePayload.create({ data: { orgId: ORG, receiptId: "r1", payloadJson: "{}", status: "failed", failureReason: "bad", receivedAt: at, firstFailedAt: first } });
    await db.receivedExpensePayload.create({ data: { orgId: ORG, receiptId: "r2", payloadJson: "{}", status: "applied" } });
    await db.receivedExpensePayload.create({ data: { orgId: "org-2", receiptId: "r3", payloadJson: "{}", status: "failed", firstFailedAt: first } });
    await db.receivedExpensePayload.create({ data: { orgId: ORG, receiptId: "r4", payloadJson: "{}", status: "failed", receivedAt: at } });
    await db.expenseReceivedOrgEvent.create({ data: { id: 51, orgId: ORG, eventType: "item_reviewed", payload: "{}", receivedAt: at, status: "failed", failureReason: "boom", firstFailedAt: first } });

    const stuck = await seedExpense({ submittedAt: at });
    await db.expense.update({ where: { id: stuck }, data: { qbMatchState: "NEEDS_FINANCE", qbFirstFailedAt: first, qbLastError: "timeout" } });
    const unpostable = await seedExpense({ submittedAt: at });
    await db.expense.update({ where: { id: unpostable }, data: { qbMatchState: "NEEDS_FINANCE" } });
    await seedExpense();

    const items = await stuckItems();

    expect(items).toHaveLength(4);
    expect(items).toEqual(expect.arrayContaining([
      { id: "r1", step: "intake", href: "/receipts/r1", failedAt: first },
      { id: "r4", step: "intake", href: "/receipts/r4", failedAt: at },
      { id: "51", step: "catalog event", href: null, failedAt: first },
      { id: stuck, step: "QuickBooks posting", href: `/expense/expenses/${stuck}`, failedAt: first },
    ]));
  });

  it("lists a QuickBooks post only while it waits at NEEDS_FINANCE, and times a qb_error expense with no stamp from its submission", async () => {
    const at = new Date("2026-11-01T10:00:00Z");
    for (const data of [{ qbMatchState: "UNMATCHED" }, { qbMatchState: "POST_FAILED" }, { state: "rejected", qbMatchState: "NEEDS_FINANCE" }]) {
      const id = await seedExpense();
      await db.expense.update({ where: { id }, data: { ...data, qbFirstFailedAt: new Date() } });
    }
    const unstamped = await seedExpense({ state: "qb_error", submittedAt: at });

    expect(await stuckItems()).toEqual([{ id: unstamped, step: "QuickBooks processing", href: `/expense/expenses/${unstamped}`, failedAt: at }]);
  });

  it("carries no error text", async () => {
    await db.receivedExpensePayload.create({ data: { orgId: ORG, receiptId: "r1", payloadJson: "{}", status: "failed", failureReason: "personal detail", firstFailedAt: new Date() } });
    const id = await seedExpense();
    await db.expense.update({ where: { id }, data: { qbMatchState: "NEEDS_FINANCE", qbFirstFailedAt: new Date(), qbLastError: "personal detail" } });

    expect(JSON.stringify(await stuckItems())).not.toContain("personal detail");
  });

  it("a second failure does not move an item's time", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fail = () => bindPorts({ signoff: { ...directory({}), personExists: async () => { throw new Error("directory down"); } } });
    const receipt = { ...fixture<{ receiptId: string }>("S2-expense-receipt/all-recognized-gtin"), needsReimbursement: true, reimburseePersonId: 7 };
    fail();
    await receiveCompletedReceipt(receipt);
    const [before] = await stuckItems();

    await new Promise((r) => setTimeout(r, 5));
    await expect(retryStuckItem({ id: before.id, step: before.step })).rejects.toMatchObject({ status: 409, message: "Retried, and it failed again; the item's page shows why" });
    await receiveCompletedReceipt(receipt);

    expect(await stuckItems()).toEqual([before]);
  });

  it("a retry of an item that is not stuck, or of an unknown step, answers 404", async () => {
    const id = await seedExpense();
    await expect(retryStuckItem({ id, step: "QuickBooks posting" })).rejects.toMatchObject({ status: 404 });
    await expect(retryStuckItem({ id: "r9", step: "intake" })).rejects.toMatchObject({ status: 404 });
    await expect(retryStuckItem({ id: "1", step: "catalog event" })).rejects.toMatchObject({ status: 404 });
    await expect(retryStuckItem({ id, step: "nonsense" })).rejects.toMatchObject({ status: 404 });
  });
});
