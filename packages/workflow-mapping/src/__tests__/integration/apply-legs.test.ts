/** Per-leg applied state: a retry never re-sends an applied leg, and an edit after one applied is logged as late. */
import { beforeEach, expect, it } from "vitest";
import { db } from "../../db";
import { lineItemService } from "../../services/lineItemService";
import { receiptService } from "../../services/receiptService";
import { orgEventConsumer } from "../../services/orgEventConsumer";
import { describeDb } from "../helpers/db";
import { MANAGER, TEST_ORG_ID, clearAll, configure, makeLineStatus, makeReceipt, recordingSinks } from "../helpers/setup";

let sinks: ReturnType<typeof recordingSinks>;

const noRef = { exists: false, gtin13: null, id: null, conversionFactor: 1, conversionVersion: 1 };
const catalog = {
  catalogReader: {
    lookupItems: async () => [],
    checkReferences: async () => ({ mfr_part: noRef, retailer_part: noRef, mfr_desc: noRef, wouldCreateNewReference: true }),
  },
  catalogSubmissions: {
    proposeItemReference: async () => ({ id: 1 }),
    reportConflict: async () => ({ id: 2 }),
    allocateProvisionalGtin: async () => "2000000000022",
    proposeProvisionalItem: async () => undefined,
  },
};

beforeEach(async () => {
  await clearAll();
  sinks = recordingSinks();
  configure({ ...catalog, ...sinks });
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

  async function lateRows(receiptId: number) {
    const rows = await db.workflowAuditLog.findMany({ where: { receivedReceiptId: receiptId, eventType: "line_edited_late" } });
    return rows.map((row) => JSON.parse(row.details ?? "null") as { appliedLegs: string[]; before: object; after: object });
  }

  it("allows a line edit once inventory applied, logged as late with before and after", async () => {
    const { r, ls } = await failedAfterPartialApply("expense");
    await lineItemService.markNonInventory(r.id, ls.id);
    expect((await db.receivedReceiptLineStatus.findUniqueOrThrow({ where: { id: ls.id } })).recognitionStatus).toBe("non_inventory");
    expect(await lateRows(r.id)).toEqual([
      {
        appliedLegs: ["inventory"],
        before: expect.objectContaining({ recognitionStatus: "recognized", assignedGtin13: "0000000000017" }),
        after: expect.objectContaining({ recognitionStatus: "non_inventory", assignedGtin13: "0000000000017" }),
      },
    ]);
    const late = await db.workflowAuditLog.findFirstOrThrow({ where: { eventType: "line_edited_late" } });
    expect(late).toMatchObject({ actorUserId: MANAGER.id, lineStatusId: ls.id });
  });

  it("allows a line edit once the money leg applied, logged as late", async () => {
    const { r, ls } = await failedAfterPartialApply("inventory");
    await lineItemService.associateGtin(r.id, ls.id, { gtin13: "0000000000024" });
    expect(await lateRows(r.id)).toEqual([
      expect.objectContaining({ appliedLegs: ["expense"], after: expect.objectContaining({ assignedGtin13: "0000000000024" }) }),
    ]);
  });

  it("a retry after a late edit sends the new lines to the failed leg only, never re-sending the applied one", async () => {
    const { r, ls } = await failedAfterPartialApply("inventory");
    await lineItemService.associateGtin(r.id, ls.id, { gtin13: "0000000000024" });
    await receiptService.retryApply(r.id);
    expect(await receiptService.apply(r.id)).toEqual({ state: "resolved" });
    expect(sinks.calls.expense).toHaveLength(1);
    expect(sinks.calls.inventory.at(-1)?.lineItems.map((li) => li.gtin13)).toEqual(["0000000000024"]);
  });

  it("an edit after inventory applied is not re-sent to inventory", async () => {
    const { r, ls } = await failedAfterPartialApply("expense");
    const inventoryCalls = sinks.calls.inventory.length;
    await lineItemService.associateGtin(r.id, ls.id, { gtin13: "0000000000024" });
    await receiptService.retryApply(r.id);
    expect(await receiptService.apply(r.id)).toEqual({ state: "resolved" });
    expect(sinks.calls.inventory).toHaveLength(inventoryCalls);
  });

  it("apply_failed with no leg applied stays editable", async () => {
    const r = await makeReceipt({ state: "applying" });
    const ls = await makeLineStatus(r.id, { recognitionStatus: "recognized", assignedGtin13: "0000000000017" });
    sinks.fail.expense = true;
    sinks.fail.inventory = true;
    expect((await receiptService.apply(r.id)).state).toBe("apply_failed");
    await lineItemService.markNonInventory(r.id, ls.id);
    expect((await db.receivedReceiptLineStatus.findUniqueOrThrow({ where: { id: ls.id } })).recognitionStatus).toBe("non_inventory");
    expect(await lateRows(r.id)).toEqual([]);
  });

  it("retry re-pushes only the legs that have not applied", async () => {
    const { r } = await failedAfterPartialApply("expense");
    await receiptService.retryApply(r.id);
    expect(await receiptService.apply(r.id)).toEqual({ state: "resolved" });
    expect(sinks.calls.inventory).toHaveLength(1);
    expect(sinks.calls.expense).toHaveLength(2);
  });

  it("the S5 remap updates a partially applied receipt without a late-edit row", async () => {
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
    expect(await db.receivedReceiptLineStatus.findUniqueOrThrow({ where: { id: ls.id } })).toMatchObject({
      recognitionStatus: "recognized",
      assignedGtin13: "0000000000017",
    });
    expect(await lateRows(r.id)).toEqual([]);
  });
});

describeDb("an inventory leg that applied but lost its stamp", () => {
  // Fails the inventory stamp for one receipt at the database, as a lost write would.
  async function failInventoryStamp(receiptId: number) {
    await db.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION test_fail_inventory_stamp() RETURNS trigger AS $$
      BEGIN
        IF NEW.id = ${receiptId} AND NEW.inventory_applied_at IS NOT NULL AND OLD.inventory_applied_at IS NULL THEN
          RAISE EXCEPTION 'inventory stamp lost';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await db.$executeRawUnsafe(`
      CREATE TRIGGER test_fail_inventory_stamp BEFORE UPDATE ON received_receipts
      FOR EACH ROW EXECUTE FUNCTION test_fail_inventory_stamp()`);
  }
  async function restoreInventoryStamp() {
    await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS test_fail_inventory_stamp ON received_receipts`);
    await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS test_fail_inventory_stamp()`);
  }

  it("stays applying with lines locked, and a retry stamps it with one inventory change", async () => {
    // A callee that dedupes per receipt, like local-inventory's per-source guard.
    const changes = new Set<string>();
    configure({
      ...sinks,
      inventorySink: {
        applyDelta: async (d) => {
          sinks.calls.inventory.push(d);
          changes.add(d.receiptId);
        },
      },
    });
    const r = await makeReceipt({ state: "applying" });
    const ls = await makeLineStatus(r.id, { recognitionStatus: "recognized", assignedGtin13: "0000000000017" });

    await failInventoryStamp(r.id);
    try {
      expect(await receiptService.apply(r.id)).toEqual({ state: "applying", error: expect.stringMatching(/inventory stamp lost/) });
    } finally {
      await restoreInventoryStamp();
    }
    const stuck = await db.receivedReceipt.findUniqueOrThrow({ where: { id: r.id } });
    expect(stuck).toMatchObject({ state: "applying", inventoryAppliedAt: null });
    await expect(lineItemService.markNonInventory(r.id, ls.id)).rejects.toMatchObject({ status: 409 });

    expect(await receiptService.retryApply(r.id)).toEqual({ state: "applying" });
    expect(await receiptService.apply(r.id)).toEqual({ state: "resolved" });

    expect(sinks.calls.inventory).toHaveLength(2);
    expect(sinks.calls.inventory[1]).toEqual(sinks.calls.inventory[0]);
    expect(changes.size).toBe(1);
    expect((await db.receivedReceipt.findUniqueOrThrow({ where: { id: r.id } })).inventoryAppliedAt).not.toBeNull();
  });

  it("a conflict from inventory still settles apply_failed, unstamped", async () => {
    configure({
      ...sinks,
      inventorySink: {
        applyDelta: async () => {
          throw new Error("This source was already applied with a different inventory delta.");
        },
      },
    });
    const r = await makeReceipt({ state: "applying" });
    await makeLineStatus(r.id, { recognitionStatus: "recognized", assignedGtin13: "0000000000017" });

    expect(await receiptService.apply(r.id)).toEqual({
      state: "apply_failed",
      error: "This source was already applied with a different inventory delta.",
    });
    expect(await db.receivedReceipt.findUniqueOrThrow({ where: { id: r.id } })).toMatchObject({
      state: "apply_failed",
      inventoryAppliedAt: null,
    });
  });
});
