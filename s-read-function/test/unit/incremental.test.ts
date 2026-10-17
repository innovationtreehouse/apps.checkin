/**
 * The incremental orchestrator (runIncremental): it drives all three streams with
 * the INCREMENTAL source and the run id, and sums their counts into the result.
 * withSyncRun and the streams are mocked so only the orchestration is under test.
 */
import { it, expect, vi, beforeEach } from "vitest";

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
}));

import { runIncremental } from "../../src/sync/incremental.js";
import { syncOrders, syncPayouts, syncBalanceTransactions } from "../../src/sync/streams.js";
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
});

it("runs all three streams with the INCREMENTAL source + run id and returns their counts", async () => {
  const heartbeat = vi.fn();
  const res = await runIncremental(prismaSentinel, client, "store-1", cfg, heartbeat);

  expect(res).toEqual({ orders: 2, payouts: 3, balanceTransactions: 7 });
  for (const fn of [syncOrders, syncPayouts, syncBalanceTransactions]) {
    expect(fn).toHaveBeenCalledWith(prismaSentinel, client, "store-1", cfg, EventSource.INCREMENTAL, 55n);
  }
  // the heartbeat sink is threaded through to withSyncRun's meta
  expect(vi.mocked(withSyncRun).mock.calls[0][5]).toEqual({ heartbeat });
});
