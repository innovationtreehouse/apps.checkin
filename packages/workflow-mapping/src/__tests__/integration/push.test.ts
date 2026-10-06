/** Push and settle: S2 / X9 money side, S3 inventory side, failure semantics, retry. */
import { beforeEach, expect, it } from "vitest";
import { CompletedReceiptSchema, ResolvedInventoryDeltaSchema } from "@inventory/receipt-types";
import { db } from "../../db";
import { executePushAndSettle } from "../../lib/apply-receipt";
import { receiptService } from "../../services/receiptService";
import { describeDb } from "../helpers/db";
import { clearAll, configure, makeLineStatus, makeReceipt, recordingSinks } from "../helpers/setup";

let sinks: ReturnType<typeof recordingSinks>;

beforeEach(async () => {
  await clearAll();
  sinks = recordingSinks();
  configure(sinks);
});

describeDb("S2 producer", () => {
  it("emits a CompletedReceipt with each resolved line's GTIN", async () => {
    const r = await makeReceipt({ state: "applying" });
    await makeLineStatus(r.id, { recognitionStatus: "recognized", assignedGtin13: "0000000000017" });
    expect(await executePushAndSettle(r.id, r, 1)).toEqual({ state: "resolved" });
    const parsed = CompletedReceiptSchema.parse(sinks.calls.expense[0]);
    expect(parsed.lineItems[0].gtin13).toBe("0000000000017");
    expect(sinks.calls.donation).toHaveLength(0);
  });

  it("carries isProvisional/provisionalName for a provisional line", async () => {
    const r = await makeReceipt({ state: "applying" });
    await makeLineStatus(r.id, { recognitionStatus: "provisional", provisionalItemGtin13: "0000000000123" });
    await executePushAndSettle(r.id, r, 1);
    const line = sinks.calls.expense[0].lineItems[0];
    expect(line).toMatchObject({ gtin13: "0000000000123", isProvisional: true, provisionalName: line.description });
  });

  it("always pushes the money side, even when no line resolves to a GTIN", async () => {
    const r = await makeReceipt({ state: "applying" });
    await makeLineStatus(r.id, { recognitionStatus: "non_inventory" });
    expect(await executePushAndSettle(r.id, r, 1)).toEqual({ state: "resolved" });
    expect(sinks.calls.expense).toHaveLength(1);
    expect(sinks.calls.inventory).toHaveLength(0);
  });
});

describeDb("X9 in-kind money side", () => {
  it("an in-kind receipt goes to donations, never to expense, and still loads inventory", async () => {
    const r = await makeReceipt({ state: "applying", isInKind: true });
    await makeLineStatus(r.id, { recognitionStatus: "recognized", assignedGtin13: "0000000000017" });
    expect(await executePushAndSettle(r.id, r, 1)).toEqual({ state: "resolved" });
    expect(sinks.calls.donation).toHaveLength(1);
    expect(sinks.calls.donation[0].isInKind).toBe(true);
    expect(sinks.calls.expense).toHaveLength(0);
    expect(sinks.calls.inventory).toHaveLength(1);
  });

  it("with the inert donation sink an in-kind receipt waits in apply_failed; purchases are unaffected", async () => {
    configure({ expenseSink: sinks.expenseSink, inventorySink: sinks.inventorySink });
    const inKind = await makeReceipt({ state: "applying", isInKind: true });
    await makeLineStatus(inKind.id, { recognitionStatus: "non_inventory" });
    const purchase = await makeReceipt({ state: "applying" });
    await makeLineStatus(purchase.id, { recognitionStatus: "non_inventory" });

    expect(await executePushAndSettle(inKind.id, inKind, 1)).toMatchObject({ state: "apply_failed", error: expect.stringMatching(/DonationSink.*not wired/) });
    expect(await executePushAndSettle(purchase.id, purchase, 1)).toEqual({ state: "resolved" });
  });
});

describeDb("S3 producer", () => {
  it("emits a ResolvedInventoryDelta with raw quantity and the line's factor", async () => {
    const r = await makeReceipt({ state: "applying" });
    await makeLineStatus(r.id, { recognitionStatus: "recognized", assignedGtin13: "0000000000017" });
    await executePushAndSettle(r.id, r, 1);
    const delta = ResolvedInventoryDeltaSchema.parse(sinks.calls.inventory[0]);
    expect(delta).toMatchObject({ receiptId: JSON.parse(r.receiptJson).receiptId, lineItems: [{ gtin13: "0000000000017", quantityDelta: 1, conversionFactor: 1 }] });
  });

  it("does not emit a delta when no line resolves to a GTIN", async () => {
    const r = await makeReceipt({ state: "applying" });
    await makeLineStatus(r.id, { recognitionStatus: "unrecognized" });
    await executePushAndSettle(r.id, r, 1);
    expect(sinks.calls.inventory).toHaveLength(0);
  });
});

describeDb("failure, retry, inert adapters", () => {
  it("inert S2/S3 adapters never fake success: the receipt waits in apply_failed", async () => {
    configure();
    const r = await makeReceipt({ state: "applying" });
    await makeLineStatus(r.id, { recognitionStatus: "recognized", assignedGtin13: "0000000000017" });
    const result = await executePushAndSettle(r.id, r, 1);
    expect(result.state).toBe("apply_failed");
    expect((await db.receivedReceipt.findUniqueOrThrow({ where: { id: r.id } })).state).toBe("apply_failed");
  });

  it("a partial failure goes to apply_failed; retry-apply then apply re-pushes only the failed leg", async () => {
    const r = await makeReceipt({ state: "applying" });
    await makeLineStatus(r.id, { recognitionStatus: "recognized", assignedGtin13: "0000000000017" });
    sinks.fail.expense = true;
    expect((await receiptService.apply(r.id)).state).toBe("apply_failed");
    expect(sinks.calls.inventory).toHaveLength(1);

    sinks.fail.expense = false;
    expect(await receiptService.retryApply(r.id)).toEqual({ state: "applying" });
    expect(await receiptService.apply(r.id)).toEqual({ state: "resolved" });
    expect(sinks.calls.expense).toHaveLength(2);
    expect(sinks.calls.inventory).toHaveLength(1);
  });

  it("apply is 409 outside applying; retry is 409 on resolved", async () => {
    const pending = await makeReceipt({ state: "pending_review" });
    await expect(receiptService.apply(pending.id)).rejects.toMatchObject({ status: 409 });
    const resolved = await makeReceipt({ state: "resolved" });
    await expect(receiptService.retryApply(resolved.id)).rejects.toMatchObject({ status: 409 });
  });

  it("a corrupt stored receipt settles apply_failed", async () => {
    const r = await db.receivedReceipt.create({ data: { orgId: "00000000-0000-0000-0000-000000000001", receiptId: "corrupt", state: "applying", receiptJson: "{" } });
    expect((await executePushAndSettle(r.id, r, 1)).state).toBe("apply_failed");
  });
});
