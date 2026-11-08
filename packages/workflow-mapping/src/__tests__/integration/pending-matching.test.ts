/**
 * Matching that couldn't run on arrival: the receipt is "Matching pending", and the daily re-run
 * fills only undecided lines, sends a fully decided receipt, and gives up after five days.
 */
import { beforeEach, expect, it, vi } from "vitest";
import { KindedError, type FailureReport } from "@checkin/component-kit";
import { db } from "../../db";
import { lineItemService } from "../../services/lineItemService";
import { ingestReceipt } from "../../services/receiptIntakeService";
import { receiptService } from "../../services/receiptService";
import { MATCHING_RETRY_DAYS, retryPendingMatching } from "../../services/pendingMatching";
import { runMatching } from "../../routes";
import { describeDb } from "../helpers/db";
import { MANAGER, buildReceiptPayload, clearAll, configure, makeLineStatus, makeReceipt, recordingSinks } from "../helpers/setup";

const GTIN = "0000000000017";
const DAY_MS = 24 * 60 * 60 * 1000;

const unused = async () => {
  throw new Error("unused");
};

/** A catalog that answers `match` per lookup, or throws `down` while set. */
function catalog() {
  const state = { down: null as Error | null, match: true, seen: [] as number[][] };
  return {
    state,
    catalogReader: {
      lookupItems: async (_retailer: string, lookups: Array<{ index: number }>) => {
        state.seen.push(lookups.map((l) => l.index));
        if (state.down) throw state.down;
        return lookups.map((l) => ({
          index: l.index,
          gtin13: state.match ? GTIN : null,
          itemReferenceId: state.match ? 1 : null,
          conversionFactor: 2,
          conversionVersion: 3,
        }));
      },
      checkReferences: unused,
      getActiveItem: unused,
    },
  };
}

let cat: ReturnType<typeof catalog>;
let sinks: ReturnType<typeof recordingSinks>;
let reports: FailureReport[];

beforeEach(async () => {
  await clearAll();
  cat = catalog();
  sinks = recordingSinks();
  reports = [];
  configure({ catalogReader: cat.catalogReader, ...sinks, onFailure: (r) => void reports.push(r) });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

const receiptRow = (id: number) => db.receivedReceipt.findUniqueOrThrow({ where: { id } });
const linesOf = (id: number) => db.receivedReceiptLineStatus.findMany({ where: { receivedReceiptId: id }, orderBy: { receiptLineItemId: "asc" } });
const auditsOf = (id: number, eventType: string) => db.workflowAuditLog.findMany({ where: { receivedReceiptId: id, eventType } });

/** A receipt waiting for mapping whose matching was deferred `daysAgo` days ago, with every line unrecognized. */
async function pendingReceipt(opts: { lineCount?: number; daysAgo?: number; state?: "pending_review" | "apply_failed" } = {}) {
  const lineCount = opts.lineCount ?? 2;
  const r = await makeReceipt({ lineCount, state: opts.state });
  for (let i = 1; i <= lineCount; i++) {
    await makeLineStatus(r.id, { receiptLineItemId: i, recognitionStatus: "unrecognized" });
  }
  return db.receivedReceipt.update({
    where: { id: r.id },
    data: { matchingPendingSince: new Date(Date.now() - (opts.daysAgo ?? 1) * DAY_MS) },
  });
}

describeDb("arrival during a catalog outage", () => {
  it("saves the receipt with every line unrecognized, marks matching pending, and sends nothing", async () => {
    cat.state.down = new KindedError("system", "catalog database unreachable");
    const res = await ingestReceipt(buildReceiptPayload({ lineCount: 2 }));

    expect(res.state).toBe("pending_review");
    expect((await receiptRow(res.id)).matchingPendingSince).toBeInstanceOf(Date);
    expect((await linesOf(res.id)).map((l) => l.recognitionStatus)).toEqual(["unrecognized", "unrecognized"]);
    expect(await auditsOf(res.id, "matching_deferred")).toHaveLength(1);
    expect(sinks.calls.expense).toHaveLength(0);
  });

  it("a connection failure is deferred the same way", async () => {
    cat.state.down = new KindedError("connection", "catalog credential refused");
    const res = await ingestReceipt(buildReceiptPayload());
    expect((await receiptRow(res.id)).matchingPendingSince).toBeInstanceOf(Date);
  });

  it("a bug in the reply is not deferred: matching counts as run", async () => {
    cat.state.down = new Error("unexpected shape");
    const res = await ingestReceipt(buildReceiptPayload());
    expect((await receiptRow(res.id)).matchingPendingSince).toBeNull();
    expect(await auditsOf(res.id, "matching_deferred")).toHaveLength(0);
  });

  it("a catalog that answered leaves no flag", async () => {
    cat.state.match = false;
    const res = await ingestReceipt(buildReceiptPayload());
    expect((await receiptRow(res.id)).matchingPendingSince).toBeNull();
  });
});

describeDb("retryPendingMatching", () => {
  it("matches every line once the catalog is back, clears the flag and sends the receipt", async () => {
    const r = await pendingReceipt();

    expect(await retryPendingMatching()).toEqual({ ran: 1, deferred: 0, gaveUp: 0, errored: 0 });

    const lines = await linesOf(r.id);
    expect(lines.map((l) => [l.recognitionStatus, l.assignedGtin13, l.conversionFactor, l.conversionVersion])).toEqual([
      ["recognized", GTIN, 2, 3],
      ["recognized", GTIN, 2, 3],
    ]);
    const row = await receiptRow(r.id);
    expect(row.matchingPendingSince).toBeNull();
    expect(row.state).toBe("resolved");
    expect(sinks.calls.expense).toHaveLength(1);
    const matched = await auditsOf(r.id, "line_matched");
    expect(matched).toHaveLength(2);
    expect(matched.every((a) => a.actorUserId === null)).toBe(true);
    expect(await auditsOf(r.id, "matching_ran")).toHaveLength(1);
    expect((await auditsOf(r.id, "auto_proceed_triggered"))[0]?.actorUserId).toBeNull();
  });

  it("never touches a line a person has decided, and sends the receipt once every line is decided", async () => {
    const r = await pendingReceipt();
    await db.receivedReceiptLineStatus.updateMany({
      where: { receivedReceiptId: r.id, receiptLineItemId: 1 },
      data: { recognitionStatus: "non_inventory" },
    });

    await retryPendingMatching();

    expect(cat.state.seen.map((lookups) => lookups.length)).toEqual([1]);
    const lines = await linesOf(r.id);
    expect(lines.map((l) => [l.recognitionStatus, l.assignedGtin13])).toEqual([
      ["non_inventory", null],
      ["recognized", GTIN],
    ]);
    expect((await receiptRow(r.id)).state).toBe("resolved");
  });

  it("no match is a real answer: the flag clears and the receipt waits for mapping", async () => {
    cat.state.match = false;
    const r = await pendingReceipt();

    expect(await retryPendingMatching()).toMatchObject({ ran: 1 });

    const row = await receiptRow(r.id);
    expect(row.matchingPendingSince).toBeNull();
    expect(row.state).toBe("pending_review");
    expect(await auditsOf(r.id, "line_matched")).toHaveLength(0);
    expect(await retryPendingMatching()).toEqual({ ran: 0, deferred: 0, gaveUp: 0, errored: 0 });
  });

  it("keeps the flag while the catalog is still down, and reports nothing before five days", async () => {
    cat.state.down = new KindedError("system", "still down");
    const r = await pendingReceipt({ daysAgo: MATCHING_RETRY_DAYS - 1 });

    expect(await retryPendingMatching()).toEqual({ ran: 0, deferred: 1, gaveUp: 0, errored: 0 });

    expect((await receiptRow(r.id)).matchingPendingSince).not.toBeNull();
    expect(reports).toEqual([]);
  });

  it("an unbound catalog at re-run keeps the flag", async () => {
    configure({ ...sinks, onFailure: (rep) => void reports.push(rep) });
    const r = await pendingReceipt();

    expect(await retryPendingMatching()).toMatchObject({ errored: 1 });
    expect((await receiptRow(r.id)).matchingPendingSince).not.toBeNull();
  });

  it("an unbound catalog gives up after five days too, recording the failure's kind", async () => {
    configure({ ...sinks, onFailure: (rep) => void reports.push(rep) });
    const r = await pendingReceipt({ daysAgo: MATCHING_RETRY_DAYS });

    expect(await retryPendingMatching()).toMatchObject({ gaveUp: 1 });
    const [gaveUp] = await auditsOf(r.id, "matching_gave_up");
    expect(JSON.parse(gaveUp?.details ?? "{}")).toMatchObject({ kind: "settings" });
    expect(reports).toEqual([{ lane: "matching", kind: "settings", detail: `receipt ${r.receiptId}` }]);
  });

  it("after five days stops, leaves the lines for hand mapping, and reports once to the on-failure port", async () => {
    cat.state.down = new KindedError("system", "still down");
    const r = await pendingReceipt({ daysAgo: MATCHING_RETRY_DAYS });

    expect(await retryPendingMatching()).toEqual({ ran: 0, deferred: 0, gaveUp: 1, errored: 0 });

    const row = await receiptRow(r.id);
    expect(row.matchingPendingSince).toBeNull();
    expect(row.state).toBe("pending_review");
    expect((await linesOf(r.id)).every((l) => l.recognitionStatus === "unrecognized")).toBe(true);
    expect(await auditsOf(r.id, "matching_gave_up")).toHaveLength(1);
    expect(reports).toEqual([{ lane: "matching", kind: "system", detail: `receipt ${r.receiptId}` }]);

    expect(await retryPendingMatching()).toEqual({ ran: 0, deferred: 0, gaveUp: 0, errored: 0 });
    expect(reports).toHaveLength(1);
  });

  it("leaves a receipt that is no longer waiting for mapping alone", async () => {
    const r = await pendingReceipt({ state: "apply_failed" });

    expect(await retryPendingMatching()).toEqual({ ran: 0, deferred: 0, gaveUp: 0, errored: 0 });
    expect((await linesOf(r.id)).every((l) => l.recognitionStatus === "unrecognized")).toBe(true);
  });

  it("leaves a receipt without the flag alone", async () => {
    const r = await makeReceipt({ lineCount: 1 });
    await makeLineStatus(r.id, { receiptLineItemId: 1, recognitionStatus: "unrecognized" });

    expect(await retryPendingMatching()).toEqual({ ran: 0, deferred: 0, gaveUp: 0, errored: 0 });
    expect(cat.state.seen).toEqual([]);
  });
});

describeDb("a person sends a receipt whose matching is pending", () => {
  it("a manual proceed clears the flag", async () => {
    const r = await pendingReceipt({ lineCount: 1 });
    await db.receivedReceiptLineStatus.updateMany({ where: { receivedReceiptId: r.id }, data: { recognitionStatus: "non_inventory" } });

    await receiptService.proceed(r.id);

    expect((await receiptRow(r.id)).matchingPendingSince).toBeNull();
  });

  it("mapping the last line by hand clears the flag as the receipt is sent", async () => {
    const r = await pendingReceipt({ lineCount: 1 });
    const line = await db.receivedReceiptLineStatus.findFirstOrThrow({ where: { receivedReceiptId: r.id } });

    await lineItemService.markNonInventory(r.id, line.id);

    const row = await receiptRow(r.id);
    expect(row.state).not.toBe("pending_review");
    expect(row.matchingPendingSince).toBeNull();
  });
});

describeDb("Run matching now", () => {
  const runNow = (id: number) => runMatching({ req: new Request("http://test/run-matching", { method: "POST" }), params: { id: String(id) } });

  it("matches the receipt at once, records who ran it, and sends it once every line is decided", async () => {
    const r = await pendingReceipt();

    expect(await runNow(r.id)).toEqual({ ReceivedReceipt: { id: r.id, state: "resolved" } });

    expect((await linesOf(r.id)).map((l) => l.recognitionStatus)).toEqual(["recognized", "recognized"]);
    expect((await receiptRow(r.id)).matchingPendingSince).toBeNull();
    const [ran] = await auditsOf(r.id, "matching_ran");
    expect(ran).toMatchObject({ actorUserId: MANAGER.id, actorUsername: MANAGER.name });
    expect(JSON.parse(ran?.details ?? "{}")).toEqual({ matched: 2 });
  });

  it("leaves the receipt pending while the catalog is still down, and reports nothing", async () => {
    cat.state.down = new KindedError("system", "still down");
    const r = await pendingReceipt();

    expect(await runNow(r.id)).toEqual({ ReceivedReceipt: { id: r.id, state: "pending_review" } });

    expect((await receiptRow(r.id)).matchingPendingSince).not.toBeNull();
    expect(reports).toEqual([]);
  });

  it("refuses a receipt whose matching already ran", async () => {
    const r = await makeReceipt({ lineCount: 1 });
    await makeLineStatus(r.id, { receiptLineItemId: 1, recognitionStatus: "unrecognized" });

    await expect(runNow(r.id)).rejects.toMatchObject({ status: 409 });
    expect(cat.state.seen).toEqual([]);
  });

  it("refuses a receipt that is no longer waiting for mapping", async () => {
    const r = await pendingReceipt({ state: "apply_failed" });

    await expect(runNow(r.id)).rejects.toMatchObject({ status: 409 });
    expect(cat.state.seen).toEqual([]);
  });
});
