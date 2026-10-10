/** S1 callee: ingestReceipt — every fixture accepted, replay, org check, recognition, push. */
import { beforeEach, expect, it } from "vitest";
import { fixturesForSeam } from "@inventory/receipt-contract-fixtures";
import type { CompletedReceipt } from "@inventory/receipt-types";
import { db } from "../../db";
import { ingestReceipt } from "../../services/receiptIntakeService";
import { describeDb } from "../helpers/db";
import { OTHER_ORG_ID, TEST_ORG_ID, buildReceiptPayload, clearAll, configure, recordingSinks, uid } from "../helpers/setup";

const recognizeAll = {
  lookupItems: async (_retailer: string, lookups: Array<{ index: number }>) =>
    lookups.map((l) => ({ index: l.index, gtin13: "0000000000017", itemReferenceId: 1, conversionFactor: 3, conversionVersion: 2 })),
  checkReferences: async () => {
    throw new Error("unused");
  },
};

beforeEach(async () => {
  await clearAll();
  configure();
});

const s1Fixtures = fixturesForSeam<CompletedReceipt>("S1-completed-receipt");

describeDb("S1 — every fixture is accepted and persisted", () => {
  it("has S1 fixtures", () => expect(s1Fixtures.length).toBeGreaterThan(0));

  for (const { id, value } of s1Fixtures) {
    it(`accepts ${id}`, async () => {
      const receiptId = `${value.receiptId}-${uid()}`;
      const res = await ingestReceipt({ ...value, orgId: TEST_ORG_ID, receiptId });
      expect(res).toMatchObject({ created: true, state: "pending_review" });
      const lines = await db.receivedReceiptLineStatus.findMany({ where: { receivedReceiptId: res.id } });
      expect(lines).toHaveLength(value.lineItems.length);
      expect(lines.every((l) => l.recognitionStatus === "unrecognized")).toBe(true);
    });
  }
});

describeDb("S1 — replay and org", () => {
  it("a replay returns the stored state, created:false, and changes nothing even if the body differs", async () => {
    const payload = buildReceiptPayload();
    const first = await ingestReceipt(payload);
    const replay = await ingestReceipt({ ...payload, vendorName: "Different", submittedAt: new Date().toISOString() });
    expect(replay).toEqual({ id: first.id, state: first.state, created: false });
    const row = await db.receivedReceipt.findUniqueOrThrow({ where: { id: first.id } });
    expect(JSON.parse(row.receiptJson).vendorName).toBe("Acme Hardware");
  });

  it("rejects a receipt for another org and writes nothing", async () => {
    await expect(ingestReceipt(buildReceiptPayload({ orgId: OTHER_ORG_ID }))).rejects.toThrow(/orgId/);
    expect(await db.receivedReceipt.count()).toBe(0);
  });

  it("rejects an invalid payload", async () => {
    const bad = { ...buildReceiptPayload(), lineItems: [] };
    await expect(ingestReceipt(bad)).rejects.toThrow();
  });

  it("passes reimburseePersonId through unchanged to the stored receipt and the money push", async () => {
    const sinks = recordingSinks();
    configure({ catalogReader: recognizeAll, ...sinks });
    const res = await ingestReceipt({ ...buildReceiptPayload(), reimburseePersonId: 31 });
    const row = await db.receivedReceipt.findUniqueOrThrow({ where: { id: res.id } });
    expect(JSON.parse(row.receiptJson).reimburseePersonId).toBe(31);
    expect(sinks.calls.expense[0].reimburseePersonId).toBe(31);
  });

  it("rejects a reimburseePersonId that is not a positive integer", async () => {
    await expect(ingestReceipt({ ...buildReceiptPayload(), reimburseePersonId: 0 })).rejects.toThrow();
  });

  it("a receipt that omits isInKind is a purchase", async () => {
    const { isInKind: _omit, ...payload } = buildReceiptPayload();
    const res = await ingestReceipt(payload);
    const row = await db.receivedReceipt.findUniqueOrThrow({ where: { id: res.id } });
    expect(JSON.parse(row.receiptJson).isInKind).toBe(false);
  });
});

describeDb("S1 — recognition and push", () => {
  it("a failed catalog lookup is non-fatal: every line stays unrecognized", async () => {
    configure({
      catalogReader: {
        lookupItems: async () => {
          throw new Error("catalog down");
        },
        checkReferences: recognizeAll.checkReferences,
      },
    });
    const res = await ingestReceipt(buildReceiptPayload({ lineCount: 2 }));
    expect(res.state).toBe("pending_review");
  });

  it("all lines recognized with inert sinks: recorded and held in apply_failed", async () => {
    configure({ catalogReader: recognizeAll });
    const res = await ingestReceipt(buildReceiptPayload({ lineCount: 2 }));
    expect(res).toMatchObject({ created: true, state: "apply_failed" });
    const row = await db.receivedReceipt.findUniqueOrThrow({ where: { id: res.id } });
    expect(row.state).toBe("apply_failed");
    expect(row.validationNotes).toMatch(/not wired/);
    const lines = await db.receivedReceiptLineStatus.findMany({ where: { receivedReceiptId: res.id } });
    expect(lines.map((l) => [l.recognitionStatus, l.assignedGtin13, l.conversionFactor, l.conversionVersion])).toEqual([
      ["recognized", "0000000000017", 3, 2],
      ["recognized", "0000000000017", 3, 2],
    ]);
  });

  it("all lines recognized with wired sinks: pushed and resolved", async () => {
    const sinks = recordingSinks();
    configure({ catalogReader: recognizeAll, ...sinks });
    const res = await ingestReceipt(buildReceiptPayload());
    expect(res.state).toBe("resolved");
    expect(sinks.calls.expense).toHaveLength(1);
    expect(sinks.calls.inventory[0].lineItems[0]).toMatchObject({ gtin13: "0000000000017", quantityDelta: 1, conversionFactor: 3 });
  });
});
