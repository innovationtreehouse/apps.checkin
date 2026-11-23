/**
 * The incremental orchestrator (runIncremental): it drives all three streams with
 * the INCREMENTAL source and the run id, then re-reads the recent payouts and
 * balance transactions, and sums their counts into the result.
 * withSyncRun and the streams are mocked so only the orchestration is under test.
 */
import { it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@checkin/s-ingest-core", () => ({
  EventSource: { INCREMENTAL: "INCREMENTAL" },
  SyncKind: { INCREMENTAL: "INCREMENTAL" },
  withSyncRun: vi.fn(async (_p, _s, _k, _scope, fn) => fn(55n)),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../src/sync/streams.js", () => ({
  syncOrders: vi.fn(),
  syncPayouts: vi.fn(),
  syncBalanceTransactions: vi.fn(),
  rereadPayouts: vi.fn(),
  rereadBalanceTransactions: vi.fn(),
}));

import { runIncremental } from "../../src/sync/incremental.js";
import {
  syncOrders,
  syncPayouts,
  syncBalanceTransactions,
  rereadPayouts,
  rereadBalanceTransactions,
} from "../../src/sync/streams.js";
import { withSyncRun, EventSource } from "@checkin/s-ingest-core";
import { fakeClient } from "../helpers/fakeClient.js";
import { prismaSentinel } from "../helpers/fakePrisma.js";

const cfg = { cutoverDate: "2026-01-01" } as never;
const client = fakeClient({});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(syncOrders).mockResolvedValue({ count: 2, inserted: 2, maxOccurredAt: null });
  vi.mocked(syncPayouts).mockResolvedValue({ count: 3, inserted: 1, maxOccurredAt: null });
  vi.mocked(syncBalanceTransactions).mockResolvedValue({ count: 7, inserted: 7, maxOccurredAt: null });
  vi.mocked(rereadPayouts).mockResolvedValue({ count: 4, changed: 1, stopped: false });
  vi.mocked(rereadBalanceTransactions).mockResolvedValue({ count: 9, changed: 0, stopped: false });
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.SYNC_DEADLINE_MINUTES;
});

it("runs all three streams with the INCREMENTAL source + run id and returns their counts", async () => {
  const heartbeat = vi.fn();
  const res = await runIncremental(prismaSentinel, client, "store-1", cfg, heartbeat);

  expect(res).toEqual({
    orders: 2,
    payouts: 3,
    balanceTransactions: 7,
    payoutsReread: 4,
    balanceTransactionsReread: 9,
    rereadStopped: false,
  });
  for (const fn of [syncOrders, syncPayouts, syncBalanceTransactions]) {
    expect(fn).toHaveBeenCalledWith(prismaSentinel, client, "store-1", cfg, EventSource.INCREMENTAL, 55n);
  }
  // the heartbeat sink is threaded through to withSyncRun's meta
  expect(vi.mocked(withSyncRun).mock.calls[0][5]).toEqual({ heartbeat });
});

it("re-reads after every forward pull, so a re-read can never hold back the forward read", async () => {
  const order: string[] = [];
  const stream = { count: 0, inserted: 0, maxOccurredAt: null };
  const reread = { count: 0, changed: 0, stopped: false };
  vi.mocked(syncOrders).mockImplementation(async () => {
    order.push("orders");
    return stream;
  });
  vi.mocked(syncPayouts).mockImplementation(async () => {
    order.push("payouts");
    return stream;
  });
  vi.mocked(syncBalanceTransactions).mockImplementation(async () => {
    order.push("balance");
    return stream;
  });
  vi.mocked(rereadPayouts).mockImplementation(async () => {
    order.push("reread payouts");
    return reread;
  });
  vi.mocked(rereadBalanceTransactions).mockImplementation(async () => {
    order.push("reread balance");
    return reread;
  });

  await runIncremental(prismaSentinel, client, "store-1", cfg);

  expect(order).toEqual(["orders", "payouts", "balance", "reread payouts", "reread balance"]);
});

it("gives the re-read half of the run deadline and reports when it stopped there", async () => {
  vi.useFakeTimers({ now: new Date("2026-11-20T00:00:00Z") });
  process.env.SYNC_DEADLINE_MINUTES = "40";
  vi.mocked(rereadBalanceTransactions).mockResolvedValue({ count: 3, changed: 0, stopped: true });

  const res = await runIncremental(prismaSentinel, client, "store-1", cfg);

  const stopAt = new Date("2026-11-20T00:20:00Z");
  expect(rereadPayouts).toHaveBeenCalledWith(prismaSentinel, client, "store-1", stopAt, 55n);
  expect(rereadBalanceTransactions).toHaveBeenCalledWith(prismaSentinel, client, "store-1", stopAt, 55n);
  expect(res.rereadStopped).toBe(true);
});
