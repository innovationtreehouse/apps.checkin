/**
 * The backfill bulk-operation state machine (stepOrdersBulk, exercised through
 * runBackfill). Each transition is asserted along with its DB side effects:
 *   none tracked        → start a bulk op, persist its id, return STARTED
 *   tracked + RUNNING   → poll, return RUNNING with objectCount
 *   tracked + COMPLETED → download + ingest, advance watermark, clear state, INGESTED
 *   COMPLETED, no url    → clear state, INGESTED with 0 (no ingest, no watermark move)
 *   FAILED/CANCELED/EXPIRED → clear state, FAILED with errorCode
 *   tracked op gone/replaced → clear state, NONE
 *
 * withSyncRun, the cursor/bulk-state core fns, the bulk lifecycle module, and the
 * payout/balance streams are all mocked so only the state machine is under test.
 */
import { it, expect, vi, beforeEach } from "vitest";

vi.mock("@checkin/s-ingest-core", () => ({
  EventSource: { BACKFILL: "BACKFILL" },
  ObjectType: { ORDER: "ORDER" },
  SyncKind: { BACKFILL: "BACKFILL" },
  // Run the wrapped fn directly with a deterministic runId; bookkeeping is core's concern.
  withSyncRun: vi.fn(async (_p, _s, _k, _scope, fn) => fn(99n)),
  advanceWatermark: vi.fn(),
  getBulkState: vi.fn(),
  setBulkState: vi.fn(),
  ingestBulkOrders: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../src/shopify/bulk.js", () => ({
  startOrdersBackfill: vi.fn(),
  getCurrentBulkOperation: vi.fn(),
  downloadBulkJsonl: vi.fn(),
}));

vi.mock("../../src/sync/streams.js", () => ({
  syncPayouts: vi.fn().mockResolvedValue({ count: 3, inserted: 3, maxOccurredAt: null }),
  syncBalanceTransactions: vi.fn().mockResolvedValue({ count: 5, inserted: 5, maxOccurredAt: null }),
}));

import { runBackfill } from "../../src/sync/backfill.js";
import { getBulkState, setBulkState, ingestBulkOrders, advanceWatermark, ObjectType } from "@checkin/s-ingest-core";
import { startOrdersBackfill, getCurrentBulkOperation, downloadBulkJsonl } from "../../src/shopify/bulk.js";
import { fakeClient } from "../helpers/fakeClient.js";
import { prismaSentinel } from "../helpers/fakePrisma.js";

const cfg = { cutoverDate: "2026-01-01" } as never;
const client = fakeClient({});
const run = () => runBackfill(prismaSentinel, client, "store-1", cfg);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(setBulkState).mockResolvedValue(undefined);
  vi.mocked(advanceWatermark).mockResolvedValue(undefined);
});

it("starts a bulk op when none is tracked and returns STARTED", async () => {
  vi.mocked(getBulkState).mockResolvedValue({ bulkOperationId: null, bulkStatus: null });
  vi.mocked(startOrdersBackfill).mockResolvedValue({ id: "gid://op/1", status: "CREATED" });

  const res = await run();

  expect(res.ordersBulk).toEqual({ action: "STARTED", operationId: "gid://op/1", status: "CREATED" });
  // cutover passed as an ISO instant
  expect(vi.mocked(startOrdersBackfill).mock.calls[0][1]).toBe(new Date("2026-01-01").toISOString());
  expect(setBulkState).toHaveBeenCalledWith(prismaSentinel, "store-1", ObjectType.ORDER, {
    bulkOperationId: "gid://op/1",
    bulkStatus: "CREATED",
  });
  expect(getCurrentBulkOperation).not.toHaveBeenCalled();
  // payouts + balance still pulled in the same run
  expect(res).toMatchObject({ payouts: 3, balanceTransactions: 5 });
});

it("polls a tracked op still running and returns RUNNING with objectCount", async () => {
  vi.mocked(getBulkState).mockResolvedValue({ bulkOperationId: "gid://op/1", bulkStatus: "RUNNING" });
  vi.mocked(getCurrentBulkOperation).mockResolvedValue({ id: "gid://op/1", status: "RUNNING", objectCount: "1234" });

  const res = await run();

  expect(res.ordersBulk).toEqual({ action: "RUNNING", status: "RUNNING", objectCount: "1234" });
  expect(startOrdersBackfill).not.toHaveBeenCalled();
  expect(setBulkState).not.toHaveBeenCalled();
});

it("downloads + ingests a COMPLETED op, advances the watermark, clears state, returns INGESTED", async () => {
  const maxOccurredAt = new Date("2026-03-15T00:00:00Z");
  vi.mocked(getBulkState).mockResolvedValue({ bulkOperationId: "gid://op/1", bulkStatus: "RUNNING" });
  vi.mocked(getCurrentBulkOperation).mockResolvedValue({ id: "gid://op/1", status: "COMPLETED", url: "https://storage.googleapis.com/shopify-bulk/result.jsonl" });
  vi.mocked(downloadBulkJsonl).mockResolvedValue('{"id":"gid://shopify/Order/1"}\n');
  vi.mocked(ingestBulkOrders).mockResolvedValue({ exportId: 7n, recordCount: 1, ingested: 1, badLineCount: 0, maxOccurredAt });

  const res = await run();

  expect(downloadBulkJsonl).toHaveBeenCalledWith("https://storage.googleapis.com/shopify-bulk/result.jsonl");
  expect(vi.mocked(ingestBulkOrders).mock.calls[0][1]).toMatchObject({
    storeId: "store-1",
    jsonl: '{"id":"gid://shopify/Order/1"}\n',
    bulkOperationId: "gid://op/1",
    syncRunId: 99n,
  });
  expect(advanceWatermark).toHaveBeenCalledWith(prismaSentinel, "store-1", ObjectType.ORDER, maxOccurredAt);
  expect(setBulkState).toHaveBeenCalledWith(prismaSentinel, "store-1", ObjectType.ORDER, {
    bulkOperationId: null,
    bulkStatus: "COMPLETED",
  });
  expect(res.ordersBulk).toEqual({ action: "INGESTED", status: "COMPLETED", ingested: 1, badLines: 0 });
});

it("clears state without ingesting when COMPLETED carries no url", async () => {
  vi.mocked(getBulkState).mockResolvedValue({ bulkOperationId: "gid://op/1", bulkStatus: "RUNNING" });
  vi.mocked(getCurrentBulkOperation).mockResolvedValue({ id: "gid://op/1", status: "COMPLETED", url: null });

  const res = await run();

  expect(downloadBulkJsonl).not.toHaveBeenCalled();
  expect(ingestBulkOrders).not.toHaveBeenCalled();
  expect(advanceWatermark).not.toHaveBeenCalled();
  expect(res.ordersBulk).toEqual({ action: "INGESTED", status: "COMPLETED", ingested: 0, badLines: 0 });
});

it.each(["FAILED", "CANCELED", "EXPIRED"])("clears state and returns FAILED for a %s op", async (status) => {
  vi.mocked(getBulkState).mockResolvedValue({ bulkOperationId: "gid://op/1", bulkStatus: "RUNNING" });
  vi.mocked(getCurrentBulkOperation).mockResolvedValue({ id: "gid://op/1", status, errorCode: "ACCESS_DENIED" });

  const res = await run();

  expect(setBulkState).toHaveBeenCalledWith(prismaSentinel, "store-1", ObjectType.ORDER, {
    bulkOperationId: null,
    bulkStatus: status,
  });
  expect(res.ordersBulk).toEqual({ action: "FAILED", status, errorCode: "ACCESS_DENIED" });
});

it("clears state and returns NONE when the current op no longer matches the tracked id", async () => {
  vi.mocked(getBulkState).mockResolvedValue({ bulkOperationId: "gid://op/1", bulkStatus: "RUNNING" });
  vi.mocked(getCurrentBulkOperation).mockResolvedValue({ id: "gid://op/2", status: "RUNNING" });

  const res = await run();

  expect(setBulkState).toHaveBeenCalledWith(prismaSentinel, "store-1", ObjectType.ORDER, {
    bulkOperationId: null,
    bulkStatus: null,
  });
  expect(res.ordersBulk).toEqual({ action: "NONE" });
});

it("clears state and returns NONE when there is no current op at all", async () => {
  vi.mocked(getBulkState).mockResolvedValue({ bulkOperationId: "gid://op/1", bulkStatus: "RUNNING" });
  vi.mocked(getCurrentBulkOperation).mockResolvedValue(null);

  const res = await run();

  expect(res.ordersBulk).toEqual({ action: "NONE" });
  expect(setBulkState).toHaveBeenCalledWith(prismaSentinel, "store-1", ObjectType.ORDER, {
    bulkOperationId: null,
    bulkStatus: null,
  });
});
