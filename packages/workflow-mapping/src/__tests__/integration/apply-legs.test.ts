/** Per-leg applied state: once any downstream leg has succeeded, the receipt's lines are frozen. */
import { beforeEach, expect, it } from "vitest";
import { db } from "../../db";
import { lineItemService } from "../../services/lineItemService";
import { receiptService } from "../../services/receiptService";
import { orgEventConsumer } from "../../services/orgEventConsumer";
import { describeDb } from "../helpers/db";
import { TEST_ORG_ID, clearAll, configure, makeLineStatus, makeReceipt, recordingSinks } from "../helpers/setup";

let sinks: ReturnType<typeof recordingSinks>;

beforeEach(async () => {
  await clearAll();
  sinks = recordingSinks();
  configure(sinks);
});

async function failedAfterPartialApply(fail: "expense" | "inventory", isInKind = false) {
  const r = await makeReceipt({ state: "applying", isInKind });
  const ls = await makeLineStatus(r.id, { recognitionStatus: "recognized", assignedGtin13: "0000000000017" });
  sinks.fail[fail] = true;
  expect((await receiptService.apply(r.id)).state).toBe("apply_failed");
  sinks.fail[fail] = false;
  return { r, ls };
}

describeDb("per-leg applied state", () => {
  it("records each leg that succeeded", async () => {
    const { r } = await failedAfterPartialApply("expense");
    const row = await db.receivedReceipt.findUniqueOrThrow({ where: { id: r.id } });
    expect(row.inventoryAppliedAt).not.toBeNull();
    expect(row.expenseAppliedAt).toBeNull();
    expect(row.donationAppliedAt).toBeNull();
  });

  it("records the donation leg for an in-kind receipt", async () => {
    const { r } = await failedAfterPartialApply("inventory", true);
    const row = await db.receivedReceipt.findUniqueOrThrow({ where: { id: r.id } });
    expect(row.donationAppliedAt).not.toBeNull();
    expect(row.expenseAppliedAt).toBeNull();
    expect(row.inventoryAppliedAt).toBeNull();
  });

  it("refuses line edits (409) on apply_failed once inventory applied", async () => {
    const { r, ls } = await failedAfterPartialApply("expense");
    await expect(lineItemService.markNonInventory(r.id, ls.id)).rejects.toMatchObject({ status: 409 });
    expect((await db.receivedReceiptLineStatus.findUniqueOrThrow({ where: { id: ls.id } })).recognitionStatus).toBe("recognized");
  });

  it("refuses line edits (409) on apply_failed once the money leg applied", async () => {
    const { r, ls } = await failedAfterPartialApply("inventory");
    await expect(lineItemService.associateGtin(r.id, ls.id, { gtin13: "0000000000024" })).rejects.toMatchObject({ status: 409 });
  });

  it("apply_failed with no leg applied stays editable", async () => {
    const r = await makeReceipt({ state: "applying" });
    const ls = await makeLineStatus(r.id, { recognitionStatus: "recognized", assignedGtin13: "0000000000017" });
    sinks.fail.expense = true;
    sinks.fail.inventory = true;
    expect((await receiptService.apply(r.id)).state).toBe("apply_failed");
    await lineItemService.markNonInventory(r.id, ls.id);
    expect((await db.receivedReceiptLineStatus.findUniqueOrThrow({ where: { id: ls.id } })).recognitionStatus).toBe("non_inventory");
  });

  it("retry re-pushes only the legs that have not applied", async () => {
    const { r } = await failedAfterPartialApply("expense");
    await receiptService.retryApply(r.id);
    expect(await receiptService.apply(r.id)).toEqual({ state: "resolved" });
    expect(sinks.calls.inventory).toHaveLength(1);
    expect(sinks.calls.expense).toHaveLength(2);
  });

  it("the S5 remap leaves a partially applied receipt alone", async () => {
    const r = await makeReceipt({ state: "applying" });
    const ls = await makeLineStatus(r.id, { recognitionStatus: "provisional", provisionalItemGtin13: "2000000000015" });
    sinks.fail.expense = true;
    expect((await receiptService.apply(r.id)).state).toBe("apply_failed");
    await orgEventConsumer.onOrgEvents([
      {
        id: 1,
        orgId: TEST_ORG_ID,
        eventType: "provisional_approved",
        payload: JSON.stringify({ version: 1, provisionalGtin13: "2000000000015", realGtin13: "0000000000017", name: "W" }),
      },
    ]);
    expect((await db.receivedReceiptLineStatus.findUniqueOrThrow({ where: { id: ls.id } })).recognitionStatus).toBe("provisional");
  });
});
