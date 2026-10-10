/** Queue, counts, detail and audit-log reads. */
import { beforeEach, expect, it } from "vitest";
import { APPLY_FAILED_QUEUE_STATES } from "../../db/schema";
import { receiptService } from "../../services/receiptService";
import { describeDb } from "../helpers/db";
import { OTHER_ORG_ID, clearAll, configure, makeLineStatus, makeReceipt } from "../helpers/setup";

beforeEach(async () => {
  await clearAll();
  configure();
});

describeDb("queues", () => {
  it("lists the org's receipts by state; the apply-failed queue includes applying", async () => {
    await makeReceipt({ state: "pending_review" });
    const failed = await makeReceipt({ state: "apply_failed" });
    const stuck = await makeReceipt({ state: "applying" });
    await makeReceipt({ state: "resolved" });
    await makeReceipt({ state: "apply_failed", orgId: OTHER_ORG_ID });

    const queue = await receiptService.list(APPLY_FAILED_QUEUE_STATES);
    expect(queue.map((q) => q.id).sort()).toEqual([failed.id, stuck.id].sort());
    expect(queue[0]).toMatchObject({ vendorName: "Acme Hardware", lineItemCount: 1, receiptTotalCents: 10 });
    expect(queue[0]).not.toHaveProperty("receiptJson");
    expect(await receiptService.list()).toHaveLength(4);
  });

  it("400 on an unknown state", async () => {
    await expect(receiptService.list(["bogus"])).rejects.toMatchObject({ status: 400 });
  });

  it("counts both queues, for this org only", async () => {
    await makeReceipt({ state: "pending_review" });
    await makeReceipt({ state: "pending_review" });
    await makeReceipt({ state: "applying" });
    await makeReceipt({ state: "pending_review", orgId: OTHER_ORG_ID });
    expect(await receiptService.counts()).toEqual({ pending_review: 2, apply_failed: 0, applying: 1 });
  });
});

describeDb("detail", () => {
  it("returns lines and a projection without the stored blob, submitter, or reimbursement fields", async () => {
    const r = await makeReceipt();
    await makeLineStatus(r.id, { recognitionStatus: "unrecognized" });
    const d = await receiptService.detail(r.id);
    expect(d.lineStatuses).toHaveLength(1);
    expect(d.receipt).not.toHaveProperty("receiptJson");
    const json = JSON.stringify(d);
    expect(json).not.toMatch(/submitterId|needsReimbursement|reimbursementFor|Jane Doe/);
  });

  it("404 for another org's receipt", async () => {
    const r = await makeReceipt({ orgId: OTHER_ORG_ID });
    await expect(receiptService.detail(r.id)).rejects.toMatchObject({ status: 404 });
  });
});

describeDb("audit log", () => {
  it("returns this org's rows, newest first, filtered by receipt", async () => {
    const r = await makeReceipt();
    await makeLineStatus(r.id, { recognitionStatus: "non_inventory" });
    await receiptService.proceed(r.id);
    const rows = await receiptService.auditLog({ receiptId: r.id });
    expect(rows.map((x) => x.eventType)).toEqual(["receipt_proceeded"]);
    expect(rows[0]).toMatchObject({ actorUserId: 7, fromState: "pending_review", toState: "applying" });
    expect(await receiptService.auditLog({ receiptId: r.id + 1000 })).toEqual([]);
  });
});
