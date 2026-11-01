/**
 * Concurrency: the PROCEED / S1 hazards, and the apply / retry-apply claims.
 */
import { beforeEach, expect, it, vi } from "vitest";
import { db } from "../../db";
import { tryAutoProceedApply } from "../../lib/auto-proceed";
import { APPLY_CLAIM_TTL_MS } from "../../lib/apply-receipt";
import { receiptService } from "../../services/receiptService";
import { ingestReceipt } from "../../services/receiptIntakeService";
import { describeDb } from "../helpers/db";
import { MANAGER, buildReceiptPayload, clearAll, configure, makeLineStatus, makeReceipt, recordingSinks } from "../helpers/setup";

let sinks: ReturnType<typeof recordingSinks>;

beforeEach(async () => {
  await clearAll();
  sinks = recordingSinks();
  configure(sinks);
});

describeDb("§1 PROCEED is compare-and-set", () => {
  it("two concurrent auto-proceeds push once and settle once", async () => {
    const r = await makeReceipt({ state: "pending_review" });
    await makeLineStatus(r.id, { recognitionStatus: "recognized", assignedGtin13: "0000000000017" });

    await Promise.all([tryAutoProceedApply(r.id, r, MANAGER), tryAutoProceedApply(r.id, r, MANAGER)]);

    expect(sinks.calls.expense).toHaveLength(1);
    expect(sinks.calls.inventory).toHaveLength(1);
    const audits = await db.workflowAuditLog.findMany({ where: { receivedReceiptId: r.id } });
    expect(audits.filter((a) => a.eventType === "auto_proceed_triggered")).toHaveLength(1);
    expect(audits.filter((a) => a.eventType === "receipt_apply_succeeded")).toHaveLength(1);
  });

  it("two concurrent manual proceeds: one wins, the other gets 409", async () => {
    const r = await makeReceipt({ state: "pending_review" });
    await makeLineStatus(r.id, { recognitionStatus: "non_inventory" });

    const results = await Promise.allSettled([receiptService.proceed(r.id), receiptService.proceed(r.id)]);

    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((x): x is PromiseRejectedResult => x.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({ status: 409 });
    const audits = await db.workflowAuditLog.findMany({ where: { receivedReceiptId: r.id, eventType: "receipt_proceeded" } });
    expect(audits).toHaveLength(1);
  });
});

describeDb("§4 S1 concurrent first deliveries", () => {
  it("the loser of the P2002 race is answered as a replay", async () => {
    // Hold both deliveries inside recognition so both pass the existence check first.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let arrived = 0;
    configure({
      ...sinks,
      catalogReader: {
        lookupItems: async () => {
          if (++arrived === 2) release();
          await gate;
          return [];
        },
        checkReferences: async () => {
          throw new Error("unused");
        },
        getActiveItem: async () => {
          throw new Error("unused");
        },
      },
    });
    const payload = buildReceiptPayload();

    const [a, b] = await Promise.all([ingestReceipt(payload), ingestReceipt({ ...payload, submittedAt: new Date().toISOString() })]);

    expect([a.created, b.created].sort()).toEqual([false, true]);
    expect(a.id).toBe(b.id);
    expect(await db.receivedReceipt.count({ where: { receiptId: payload.receiptId } })).toBe(1);
    expect(await db.receivedReceiptLineStatus.count({ where: { receivedReceiptId: a.id } })).toBe(1);
  });
});

describeDb("apply and retry-apply are claimed once", () => {
  it("two concurrent applies push once; the other gets 409", async () => {
    const r = await makeReceipt({ state: "applying" });
    await makeLineStatus(r.id, { recognitionStatus: "recognized", assignedGtin13: "0000000000017" });
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    configure({
      ...sinks,
      inventorySink: {
        applyDelta: async (d) => {
          sinks.calls.inventory.push(d);
          await gate;
        },
      },
    });

    const first = receiptService.apply(r.id);
    await vi.waitFor(() => expect(sinks.calls.inventory).toHaveLength(1));
    const second = await receiptService.apply(r.id).then(
      () => null,
      (err: unknown) => err,
    );
    release();

    expect(await first).toEqual({ state: "resolved" });
    expect(second).toMatchObject({ status: 409 });
    expect(sinks.calls.inventory).toHaveLength(1);
    expect(sinks.calls.expense).toHaveLength(1);
  });

  it("a live claim refuses apply; a stale one (crashed push) is taken over and released", async () => {
    const live = await makeReceipt({ state: "applying" });
    await makeLineStatus(live.id, { recognitionStatus: "recognized", assignedGtin13: "0000000000017" });
    await db.receivedReceipt.update({ where: { id: live.id }, data: { applyClaimedAt: new Date() } });
    await expect(receiptService.apply(live.id)).rejects.toMatchObject({ status: 409 });
    expect(sinks.calls.inventory).toHaveLength(0);

    const stale = await makeReceipt({ state: "applying" });
    await makeLineStatus(stale.id, { recognitionStatus: "recognized", assignedGtin13: "0000000000017" });
    await db.receivedReceipt.update({
      where: { id: stale.id },
      data: { applyClaimedAt: new Date(Date.now() - APPLY_CLAIM_TTL_MS - 1_000) },
    });
    expect(await receiptService.apply(stale.id)).toEqual({ state: "resolved" });
    expect(sinks.calls.inventory).toHaveLength(1);
    expect((await db.receivedReceipt.findUniqueOrThrow({ where: { id: stale.id } })).applyClaimedAt).toBeNull();
  });

  it("two concurrent retry-applies: one wins, the other gets 409", async () => {
    const r = await makeReceipt({ state: "apply_failed" });

    const results = await Promise.allSettled([receiptService.retryApply(r.id), receiptService.retryApply(r.id)]);

    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((x): x is PromiseRejectedResult => x.status === "rejected");
    expect(rejected[0]?.reason).toMatchObject({ status: 409 });
    const audits = await db.workflowAuditLog.findMany({ where: { receivedReceiptId: r.id, eventType: "receipt_retry_started" } });
    expect(audits).toHaveLength(1);
  });
});
