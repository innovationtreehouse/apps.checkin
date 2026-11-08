/** The Problems list's ports: stuck receipts and failed catalog events, each timed by its first failure, and their retry. */
import { beforeEach, expect, it, vi } from "vitest";
import { db } from "../../db";
import { executePushAndSettle } from "../../lib/apply-receipt";
import { orgEventConsumer } from "../../services/orgEventConsumer";
import { retryStuckItem, stuckItems } from "../../stuckItems";
import { describeDb } from "../helpers/db";
import { OTHER_ORG_ID, TEST_ORG_ID, clearAll, configure, makeLineStatus, makeReceipt, recordingSinks } from "../helpers/setup";

let sinks: ReturnType<typeof recordingSinks>;

beforeEach(async () => {
  await clearAll();
  sinks = recordingSinks();
  configure(sinks);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

const malformed = (id: number) => ({ id, orgId: TEST_ORG_ID, eventType: "provisional_approved", payload: JSON.stringify({ version: 1, bad: true }) });
const pause = () => new Promise((r) => setTimeout(r, 5));

/** A receipt sent to apply whose expense push fails. */
async function failedApply() {
  const r = await makeReceipt({ state: "applying" });
  await makeLineStatus(r.id, { recognitionStatus: "non_inventory" });
  sinks.fail.expense = true;
  await executePushAndSettle(r.id, r);
  return r;
}

describeDb("stuckItems", () => {
  it("lists each stuck receipt with its receiving page and each failed catalog event, timed by their first failure", async () => {
    const first = new Date("2026-11-02T10:00:00Z");
    const failed = await makeReceipt({ state: "apply_failed" });
    await db.receivedReceipt.update({ where: { id: failed.id }, data: { applyFirstFailedAt: first } });
    const unstamped = await makeReceipt({ state: "applying" });
    await db.receivedReceipt.update({ where: { id: unstamped.id }, data: { applyFirstFailedAt: first } });
    const untimed = await makeReceipt({ state: "apply_failed" });
    await makeReceipt({ state: "applying" });
    await makeReceipt({ state: "pending_review" });
    await makeReceipt({ state: "apply_failed", orgId: OTHER_ORG_ID });
    await db.workflowFailedOrgEvent.create({ data: { id: 41, orgId: TEST_ORG_ID, eventType: "item_reviewed", payload: "{}", failureReason: "boom", failedAt: first } });
    await db.workflowFailedOrgEvent.create({ data: { id: 42, orgId: OTHER_ORG_ID, eventType: "item_reviewed", payload: "{}", failureReason: "boom" } });

    const items = await stuckItems();

    expect(items).toHaveLength(4);
    expect(items).toEqual(expect.arrayContaining([
      { id: failed.receiptId, step: "apply", href: `/inventory/receiving/${failed.receiptId}`, failedAt: first },
      { id: unstamped.receiptId, step: "apply", href: `/inventory/receiving/${unstamped.receiptId}`, failedAt: first },
      { id: untimed.receiptId, step: "apply", href: `/inventory/receiving/${untimed.receiptId}`, failedAt: untimed.updatedAt },
      { id: "41", step: "catalog event", href: null, failedAt: first },
    ]));
  });

  it("carries no error text", async () => {
    await failedApply();
    await orgEventConsumer.onOrgEvents([malformed(1)]);

    const text = JSON.stringify(await stuckItems());
    expect(text).not.toContain("expense down");
    expect(text).not.toContain("provisionalGtin13");
  });

  it("a failed apply records its error and first failure time; a second failure keeps the time", async () => {
    const r = await failedApply();
    const row = await db.receivedReceipt.findUniqueOrThrow({ where: { id: r.id } });
    expect(row).toMatchObject({ state: "apply_failed", validationNotes: "Expense: expense down" });
    expect(row.applyFirstFailedAt).toBeInstanceOf(Date);
    const [before] = await stuckItems();
    expect(before.failedAt).toEqual(row.applyFirstFailedAt);

    await pause();
    await retryStuckItem({ id: before.id, step: before.step });

    expect(await stuckItems()).toEqual([before]);
  });

  it("a failed catalog event's second failure keeps its time", async () => {
    await orgEventConsumer.onOrgEvents([malformed(1)]);
    const [before] = await stuckItems();

    await pause();
    await retryStuckItem({ id: before.id, step: before.step });
    await orgEventConsumer.onOrgEvents([malformed(1)]);

    expect(await stuckItems()).toEqual([before]);
  });
});

describeDb("retryStuckItem", () => {
  it("applies a stuck receipt once and clears its error and first failure time", async () => {
    const r = await failedApply();
    sinks.fail.expense = false;

    await retryStuckItem({ id: r.receiptId, step: "apply" });

    const row = await db.receivedReceipt.findUniqueOrThrow({ where: { id: r.id } });
    expect(row).toMatchObject({ state: "resolved", validationNotes: null, applyFirstFailedAt: null });
    expect(sinks.calls.expense).toHaveLength(2);
    expect(await stuckItems()).toEqual([]);
    await expect(retryStuckItem({ id: r.receiptId, step: "apply" })).rejects.toMatchObject({ status: 404 });
  });

  it("applies a failed catalog event from its stored row and removes it", async () => {
    await orgEventConsumer.onOrgEvents([malformed(1)]);
    await db.workflowFailedOrgEvent.update({
      where: { id: 1 },
      data: { eventType: "provisional_rejected", payload: JSON.stringify({ version: 1, provisionalGtin13: "2000000000022", rejectionReason: "dup" }) },
    });

    await retryStuckItem({ id: "1", step: "catalog event" });

    expect(await db.workflowFailedOrgEvent.count()).toBe(0);
    expect(await db.workflowAppliedOrgEvent.findMany({ select: { id: true } })).toEqual([{ id: 1 }]);
  });

  it("answers 404 for an item that is not stuck, another org's, or an unknown step", async () => {
    const healthy = await makeReceipt({ state: "pending_review" });
    const foreign = await makeReceipt({ state: "apply_failed", orgId: OTHER_ORG_ID });
    await db.workflowFailedOrgEvent.create({ data: { id: 42, orgId: OTHER_ORG_ID, eventType: "item_reviewed", payload: "{}", failureReason: "boom" } });

    await expect(retryStuckItem({ id: healthy.receiptId, step: "apply" })).rejects.toMatchObject({ status: 404 });
    await expect(retryStuckItem({ id: foreign.receiptId, step: "apply" })).rejects.toMatchObject({ status: 404 });
    await expect(retryStuckItem({ id: "42", step: "catalog event" })).rejects.toMatchObject({ status: 404 });
    await expect(retryStuckItem({ id: "x", step: "catalog event" })).rejects.toMatchObject({ status: 404 });
    await expect(retryStuckItem({ id: healthy.receiptId, step: "nonsense" })).rejects.toMatchObject({ status: 404 });
  });
});
