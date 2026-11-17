/** Closing an apply_failed receipt as handled by hand: the note, a disposition per unapplied part, and no push after. */
import { beforeEach, expect, it } from "vitest";
import { toHttpError } from "@checkin/component-kit";
import { db } from "../../db";
import { APPLY_FAILED_QUEUE_STATES, type ReceivedReceiptState } from "../../db/schema";
import { executePushAndSettle, sweepStuckApplying } from "../../lib/apply-receipt";
import { closeOut } from "../../routes";
import { receiptService } from "../../services/receiptService";
import { retryStuckItem, stuckItems } from "../../stuckItems";
import { describeDb } from "../helpers/db";
import { MANAGER, OTHER_ORG_ID, clearAll, configure, makeLineStatus, makeReceipt, recordingSinks } from "../helpers/setup";

let sinks: ReturnType<typeof recordingSinks>;

beforeEach(async () => {
  await clearAll();
  sinks = recordingSinks();
  configure(sinks);
});

/** An apply_failed receipt with one inventory line; `inventoryApplied` stamps the inventory leg. */
async function failedReceipt(opts: { inventoryApplied?: boolean; isInKind?: boolean; orgId?: string } = {}) {
  const r = await makeReceipt({ state: "apply_failed", isInKind: opts.isInKind, orgId: opts.orgId });
  await makeLineStatus(r.id, { recognitionStatus: "recognized", assignedGtin13: "0000000000017" });
  return db.receivedReceipt.update({
    where: { id: r.id },
    data: { applyFirstFailedAt: new Date(), validationNotes: "Expense: down", ...(opts.inventoryApplied ? { inventoryAppliedAt: new Date() } : {}) },
  });
}

const post = (id: number, body: unknown) =>
  closeOut({ req: new Request("http://localhost/x", { method: "POST", body: JSON.stringify(body) }), params: { id: String(id) } });

async function status(send: () => Promise<unknown>): Promise<number> {
  try {
    await send();
    return 200;
  } catch (err) {
    return toHttpError(err)?.status ?? 500;
  }
}

const closeRows = (id: number) => db.workflowAuditLog.findMany({ where: { receivedReceiptId: id, eventType: "receipt_closed_by_hand" } });
const stateOf = async (id: number) => (await db.receivedReceipt.findUniqueOrThrow({ where: { id } })).state;

describeDb("closeOut", () => {
  it("closes the receipt and records the note, who closed it, and each part's outcome in one audit row", async () => {
    const r = await failedReceipt({ inventoryApplied: true });

    expect(await post(r.id, { note: "Entered the expense by hand", legs: { expense: "done_by_hand" } }))
      .toEqual({ ReceivedReceipt: { id: r.id, state: "closed_by_hand" } });

    expect(await stateOf(r.id)).toBe("closed_by_hand");
    const [row] = await closeRows(r.id);
    expect(row).toMatchObject({ actorUserId: MANAGER.id, actorUsername: MANAGER.name, fromState: "apply_failed", toState: "closed_by_hand" });
    expect(JSON.parse(row.details ?? "")).toEqual({
      note: "Entered the expense by hand",
      legs: { expense: "done_by_hand", inventory: "applied" },
    });
  });

  it("names the donation leg for an in-kind receipt", async () => {
    const r = await failedReceipt({ isInKind: true });
    await post(r.id, { note: "Gift not wanted", legs: { donation: "not_needed", inventory: "not_needed" } });
    const [row] = await closeRows(r.id);
    expect(JSON.parse(row.details ?? "").legs).toEqual({ donation: "not_needed", inventory: "not_needed" });
  });

  it.each<[string, { applied?: boolean } & Record<string, unknown>]>([
    ["no note", { legs: { expense: "done_by_hand", inventory: "not_needed" } }],
    ["a blank note", { note: "   ", legs: { expense: "done_by_hand", inventory: "not_needed" } }],
    ["a part with no disposition", { note: "n", legs: { expense: "done_by_hand" } }],
    ["a part that already applied", { note: "n", legs: { expense: "done_by_hand", inventory: "not_needed" }, applied: true }],
    ["an unknown disposition", { note: "n", legs: { expense: "lost", inventory: "not_needed" } }],
  ])("refuses %s with 400 and leaves the receipt failed", async (_name, { applied, ...body }) => {
    const r = await failedReceipt({ inventoryApplied: applied });
    expect(await status(() => post(r.id, body))).toBe(400);
    expect(await stateOf(r.id)).toBe("apply_failed");
    expect(await closeRows(r.id)).toHaveLength(0);
  });

  it.each<ReceivedReceiptState>(["pending_review", "applying", "resolved"])("refuses a receipt in %s with 409", async (state) => {
    const r = await makeReceipt({ state });
    expect(await status(() => receiptService.closeOut(r.id, { note: "n", legs: {} }))).toBe(409);
    expect(await stateOf(r.id)).toBe(state);
  });

  it("can't be closed twice; of two racing close-outs one wins and one row is written", async () => {
    const r = await failedReceipt({ inventoryApplied: true });
    const body = { note: "n", legs: { expense: "done_by_hand" as const } };
    const results = await Promise.allSettled([receiptService.closeOut(r.id, body), receiptService.closeOut(r.id, body)]);
    expect(results.map((x) => x.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(await closeRows(r.id)).toHaveLength(1);
    expect(await status(() => receiptService.closeOut(r.id, body))).toBe(409);
  });

  it("401s without a signed-in caller and 404s another org's receipt", async () => {
    const r = await failedReceipt();
    const foreign = await failedReceipt({ orgId: OTHER_ORG_ID });
    const body = { note: "n", legs: { expense: "done_by_hand" as const, inventory: "not_needed" as const } };
    expect(await status(() => receiptService.closeOut(foreign.id, body))).toBe(404);
    configure({ ...sinks, principal: null });
    expect(await status(() => receiptService.closeOut(r.id, body))).toBe(401);
    expect(await stateOf(r.id)).toBe("apply_failed");
  });

  it("leaves the Problems list and the apply-failed queue, and is never pushed again", async () => {
    const r = await failedReceipt();
    await receiptService.closeOut(r.id, { note: "n", legs: { expense: "done_by_hand", inventory: "done_by_hand" } });

    expect(await stuckItems()).toEqual([]);
    expect(await receiptService.list(APPLY_FAILED_QUEUE_STATES)).toEqual([]);
    expect((await receiptService.counts()).apply_failed).toBe(0);

    expect(await status(() => receiptService.retryApply(r.id))).toBe(409);
    expect(await status(() => retryStuckItem({ id: r.receiptId, step: "apply" }))).toBe(404);
    expect(await status(() => receiptService.apply(r.id))).toBe(409);
    expect(await executePushAndSettle(r.id, r)).toBeNull();
    expect(await sweepStuckApplying()).toEqual({ resolved: 0, failed: 0, applying: 0, skipped: 0, errored: 0 });

    expect(sinks.calls).toEqual({ expense: [], donation: [], inventory: [] });
    expect(await stateOf(r.id)).toBe("closed_by_hand");
  });
});
