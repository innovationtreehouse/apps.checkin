/** The Problems list's read and retry ports: receipts stuck in the flow or on a failed push, timed by their first failure. */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ServiceError } from "@checkin/component-kit";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { db } from "../../db";
import { PUSH_GRACE_MS, receiptRepo } from "../../repositories/receipt";
import { receiptService } from "../../services/receiptService";
import { READING_FAILURES_NOTICE_AT, STILL_STUCK, problemNotices, retryStuckItem, stuckItems } from "../../stuckItems";
import { describeDb } from "../helpers/db";
import { ALICE, FINANCE, TEST_ORG_ID, actAs, clearAll, configure, manualDetails, recordingPorts, stateOf, textFile, uploadRead } from "../helpers/setup";

let ports: ReturnType<typeof recordingPorts>;

async function makeReceipt(state: string, opts: { orgId?: string; pushed?: boolean; firstFailedAt?: Date } = {}): Promise<string> {
  const orgId = opts.orgId ?? TEST_ORG_ID;
  const id = randomUUID();
  await db.receipt.create({
    data: {
      id,
      orgId,
      uploadedByUserId: ALICE.id,
      fileKey: `receipts/${id}`,
      fileHash: randomUUID(),
      mimeType: "text/plain",
      pushedAt: opts.pushed ? new Date() : null,
      firstFailedAt: opts.firstFailedAt ?? null,
      lastError: opts.firstFailedAt ? "failure text" : null,
      details: { create: { orgId, state } },
    },
  });
  return id;
}

const failure = (id: string) => db.receipt.findUniqueOrThrow({ where: { id }, select: { firstFailedAt: true, lastError: true } });

beforeEach(async () => {
  await clearAll();
  ports = recordingPorts();
  configure({ receiptSink: ports.receiptSink });
});
afterEach(() => vi.restoreAllMocks());

describeDb("stuckItems", () => {
  it("lists a flow error and a failed push, each with its page and first failure time, and no error text", async () => {
    const at = new Date("2026-11-01T10:00:00Z");
    const flow = await makeReceipt("flow_error", { firstFailedAt: at });
    const push = await makeReceipt("receipt_finalized", { firstFailedAt: at });

    const items = await stuckItems();

    expect(items).toHaveLength(2);
    expect(items).toEqual(expect.arrayContaining([
      { id: flow, step: "flow", href: `/receipts/${flow}`, failedAt: at },
      { id: push, step: "push to mapping", href: `/receipts/${push}`, failedAt: at },
    ]));
  });

  it("leaves out a pushed receipt, one finalized within the push grace, and another org's", async () => {
    const at = new Date();
    await makeReceipt("receipt_finalized", { pushed: true, firstFailedAt: at });
    await history(await makeReceipt("receipt_finalized"), [["finalized", at.toISOString()]]);
    await makeReceipt("flow_error", { orgId: "00000000-0000-0000-0000-000000000099", firstFailedAt: at });

    expect(await stuckItems()).toEqual([]);
  });

  it("keeps the first failure's time through a second failure, which records its own error", async () => {
    ports.fail.push = new Error("first");
    const r = await uploadRead(textFile(), "text/plain", { details: manualDetails() });
    const first = await failure(r.id);
    expect(first).toMatchObject({ lastError: "first" });
    expect(first.firstFailedAt).toBeInstanceOf(Date);

    ports.fail.push = new Error("second");
    await expect(retryStuckItem({ id: r.id, step: "push to mapping" })).rejects.toMatchObject({ status: 409, message: STILL_STUCK });

    expect(await failure(r.id)).toEqual({ firstFailedAt: first.firstFailedAt, lastError: "second" });
    expect(await stuckItems()).toEqual([{ id: r.id, step: "push to mapping", href: `/receipts/${r.id}`, failedAt: first.firstFailedAt }]);
  });

  it("a delivered push clears the failure and leaves the list", async () => {
    ports.fail.push = true;
    const r = await uploadRead(textFile(), "text/plain", { details: manualDetails() });
    ports.fail.push = false;

    await retryStuckItem({ id: r.id, step: "push to mapping" });

    expect(await failure(r.id)).toEqual({ firstFailedAt: null, lastError: null });
    expect(await stuckItems()).toEqual([]);
  });

  it("a retry of a receipt already delivered sends nothing", async () => {
    ports.fail.push = true;
    const r = await uploadRead(textFile(), "text/plain", { details: manualDetails() });
    ports.fail.push = false;
    await retryStuckItem({ id: r.id, step: "push to mapping" });
    const sent = ports.calls.pushes.length;

    await expect(retryStuckItem({ id: r.id, step: "push to mapping" })).rejects.toMatchObject({ status: 404 });

    expect(ports.calls.pushes).toHaveLength(sent);
  });

  it("a flow retry reruns the checks, and the receipt leaves flow_error with its failure cleared", async () => {
    const r = await uploadRead(textFile(), "text/plain", { details: manualDetails() });
    await db.receiptDetail.update({ where: { id: r.id }, data: { state: "flow_error" } });
    await db.receipt.update({ where: { id: r.id }, data: { pushedAt: null, firstFailedAt: new Date(), lastError: "boom" } });

    await retryStuckItem({ id: r.id, step: "flow" });

    expect(await stateOf(r.id)).toBe("receipt_finalized");
    expect(await failure(r.id)).toEqual({ firstFailedAt: null, lastError: null });
  });

  it("a flow retry that fails again answers 409 with fixed text, and the receipt stays stuck", async () => {
    const id = await makeReceipt("flow_error", { firstFailedAt: new Date() });
    vi.spyOn(receiptRepo, "find").mockRejectedValueOnce(new Error("secret detail"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const err = await retryStuckItem({ id, step: "flow" }).catch((e: unknown) => e);

    expect(logged).toHaveBeenCalledWith(expect.stringContaining(id), expect.objectContaining({ message: "secret detail" }));
    expect(err).toBeInstanceOf(ServiceError);
    expect(err).toMatchObject({ status: 409, message: STILL_STUCK });
    expect(await stuckItems()).toEqual([expect.objectContaining({ id, step: "flow" })]);
  });

  it("answers 404 for an unknown receipt, another org's, one not stuck in that step, or an unknown step", async () => {
    const flow = await makeReceipt("flow_error", { firstFailedAt: new Date() });
    const other = await makeReceipt("flow_error", { orgId: "00000000-0000-0000-0000-000000000099", firstFailedAt: new Date() });
    const pushed = await makeReceipt("receipt_finalized", { pushed: true, firstFailedAt: new Date() });

    for (const [id, step] of [[randomUUID(), "flow"], [other, "flow"], [flow, "push to mapping"], [pushed, "push to mapping"], [flow, "elsewhere"]]) {
      const err = await retryStuckItem({ id, step }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ServiceError);
      expect(err).toMatchObject({ status: 404 });
    }
    expect(ports.calls.pushes).toHaveLength(0);
  });
});

const SINCE_SUCCESS_SQL = readFileSync(join(__dirname, "../../../prisma/migrations/20261108140000_stuck_failure_since_success/migration.sql"), "utf8");

/** Runs the corrective backfill's update outside its BEGIN/COMMIT, one statement per call. */
async function retimeStuck(): Promise<void> {
  const statements = SINCE_SUCCESS_SQL.replace(/^\s*--.*$/gm, "").split(";").map((s) => s.trim());
  for (const statement of statements.filter((s) => s && s !== "BEGIN" && s !== "COMMIT")) await db.$executeRawUnsafe(statement);
}

async function history(receiptId: string, rows: Array<[action: string, at: string]>): Promise<void> {
  for (const [action, at] of rows) await db.receiptAuditLog.create({ data: { receiptId, action, changedAt: new Date(at) } });
}

/** A receipt finalized by the flow whose push never ran or never recorded its failure, finalized `agoMs` before now. */
async function undeliveredSilently(agoMs: number): Promise<{ id: string; finalizedAt: Date }> {
  ports.fail.push = true;
  const r = await uploadRead(textFile(), "text/plain", { details: manualDetails() });
  ports.fail.push = false;
  const finalizedAt = new Date(Date.now() - agoMs);
  await db.receipt.update({ where: { id: r.id }, data: { firstFailedAt: null, lastError: null } });
  await db.receiptAuditLog.updateMany({ where: { receiptId: r.id, action: "finalized" }, data: { changedAt: finalizedAt } });
  return { id: r.id, finalizedAt };
}

describeDb("an undelivered receipt with no recorded failure", () => {
  it("past the push grace, it is listed timed by its finalize, counted for finance, and a retry delivers it", async () => {
    const { id, finalizedAt } = await undeliveredSilently(PUSH_GRACE_MS + 60_000);

    expect(await stuckItems()).toEqual([{ id, step: "push to mapping", href: `/receipts/${id}`, failedAt: finalizedAt }]);
    expect((await receiptService.countAwaitingFinance(FINANCE.id)).total).toBe(1);
    actAs(FINANCE);
    expect((await receiptService.listNeedsAttention("finance")).map((r) => r.id)).toEqual([id]);

    await retryStuckItem({ id, step: "push to mapping" });

    expect((await db.receipt.findUniqueOrThrow({ where: { id } })).pushedAt).not.toBeNull();
    expect(await stuckItems()).toEqual([]);
    expect((await receiptService.countAwaitingFinance(FINANCE.id)).total).toBe(0);
  });

  it("within the push grace, it is not listed, not counted, and not retried", async () => {
    const { id } = await undeliveredSilently(PUSH_GRACE_MS - 60_000);
    const sent = ports.calls.pushes.length;

    expect(await stuckItems()).toEqual([]);
    expect((await receiptService.countAwaitingFinance(FINANCE.id)).total).toBe(0);
    await expect(retryStuckItem({ id, step: "push to mapping" })).rejects.toMatchObject({ status: 404 });
    expect(ports.calls.pushes).toHaveLength(sent);
  });
});

describeDb("first failure backfill since the last success", () => {
  const OLD = "2026-09-01T10:00:00.000Z";
  const NEW = "2026-11-07T10:00:00.000Z";

  it("times a stuck receipt from its failure after its last success, not an older resolved one", async () => {
    const flow = await makeReceipt("flow_error", { firstFailedAt: new Date(OLD) });
    await history(flow, [["pipeline_failed", OLD], ["pipeline_transition", "2026-09-02T10:00:00.000Z"], ["pipeline_failed", NEW]]);
    const push = await makeReceipt("receipt_finalized", { firstFailedAt: new Date(OLD) });
    await history(push, [["donor_sync_failed", OLD], ["finalized", "2026-09-02T10:00:00.000Z"], ["push_failed", NEW], ["push_failed", "2026-11-08T10:00:00.000Z"]]);

    await retimeStuck();

    expect((await failure(flow)).firstFailedAt).toEqual(new Date(NEW));
    expect((await failure(push)).firstFailedAt).toEqual(new Date(NEW));
  });

  it("leaves a receipt that is not stuck, or has no failure since its last success, as it was", async () => {
    const pushed = await makeReceipt("receipt_finalized", { pushed: true, firstFailedAt: new Date(OLD) });
    await history(pushed, [["push_failed", NEW]]);
    const noneSince = await makeReceipt("flow_error", { firstFailedAt: new Date(OLD) });
    await history(noneSince, [["pipeline_failed", OLD], ["pipeline_transition", NEW]]);
    const neverFailed = await makeReceipt("flow_error");
    await history(neverFailed, [["pipeline_failed", NEW]]);

    await retimeStuck();

    expect(await failure(pushed)).toEqual({ firstFailedAt: new Date(OLD), lastError: "failure text" });
    expect(await failure(noneSince)).toEqual({ firstFailedAt: new Date(OLD), lastError: "failure text" });
    expect(await failure(neverFailed)).toEqual({ firstFailedAt: null, lastError: null });
  });
});

describeDb("problemNotices", () => {
  const now = new Date("2026-11-08T12:00:00Z");
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3600_000);
  async function failedReadings(...at: Date[]) {
    const id = await makeReceipt("ocr_failed");
    await db.receiptAuditLog.createMany({ data: at.map((changedAt, i) => ({ receiptId: id, action: i % 2 ? "ocr_failed:data" : "ocr_failed:system", changedAt, valueAfter: "failure text" })) });
  }

  it("shows no line for fewer failed readings than the threshold in the last day", async () => {
    expect(READING_FAILURES_NOTICE_AT).toBe(3);
    await failedReadings(hoursAgo(1), hoursAgo(2));
    expect(await problemNotices(now)).toEqual([]);
  });

  it("shows one line, with the count and no error text, once the threshold is reached", async () => {
    await failedReadings(hoursAgo(1), hoursAgo(2), hoursAgo(23));
    expect(await problemNotices(now)).toEqual(["Receipt reading failed 3 times in the last day"]);
  });

  it("leaves out failures older than a day, another org's, and receipts moved to manual entry without a reading", async () => {
    await failedReadings(hoursAgo(1), hoursAgo(2), hoursAgo(25));
    const other = await makeReceipt("ocr_failed", { orgId: "00000000-0000-0000-0000-000000000099" });
    const switchedOff = await makeReceipt("ocr_failed");
    await db.receiptAuditLog.createMany({
      data: [
        { receiptId: other, action: "ocr_failed:system", changedAt: hoursAgo(1) },
        { receiptId: switchedOff, action: "ocr_failed", changedAt: hoursAgo(1), valueAfter: "automatic reading turned off" },
      ],
    });
    expect(await problemNotices(now)).toEqual([]);
  });
});

describeDb("problemNotices: receipts waiting to be read", () => {
  const now = new Date("2026-11-08T12:00:00Z");
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3600_000);
  async function queued(at: Date, orgId = TEST_ORG_ID) {
    const id = await makeReceipt("ocr_queued", { orgId });
    await db.receiptDetail.update({ where: { id }, data: { ocrQueuedAt: at } });
  }

  it("shows no line while every waiting receipt has waited 25 hours or less", async () => {
    await queued(hoursAgo(25));
    await queued(hoursAgo(1));
    expect(await problemNotices(now)).toEqual([]);
  });

  it("counts receipts waiting more than 25 hours and names the oldest's wait in days", async () => {
    await queued(hoursAgo(26));
    await queued(hoursAgo(75));
    await queued(hoursAgo(1));
    expect(await problemNotices(now)).toEqual(["2 receipts waiting to be read, the oldest for 3 days"]);
  });

  it("says one receipt and one day, and leaves out another org's and one already being read", async () => {
    await queued(hoursAgo(30));
    await queued(hoursAgo(80), "00000000-0000-0000-0000-000000000099");
    const reading = await makeReceipt("auto_upload");
    await db.receiptDetail.update({ where: { id: reading }, data: { ocrQueuedAt: hoursAgo(80) } });
    expect(await problemNotices(now)).toEqual(["1 receipt waiting to be read, the oldest for 1 day"]);
  });
});
