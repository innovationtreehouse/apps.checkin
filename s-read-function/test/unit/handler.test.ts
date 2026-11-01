/**
 * The Lambda entry point (handler): event routing, the reap-then-resolve-store
 * startup order, and — the important branch — that a ConcurrentRunError is swallowed
 * into a clean `{ skipped: true }` while any other error propagates. All collaborators
 * are mocked so this isolates the handler's own control flow.
 */
import { it, expect, vi, beforeEach } from "vitest";

// Hoisted so the class exists when the (hoisted) vi.mock factory below references it.
const { ConcurrentRunError } = vi.hoisted(() => ({
  ConcurrentRunError: class ConcurrentRunError extends Error {
    constructor() {
      super("advisory lock already held");
      this.name = "ConcurrentRunError";
    }
  },
}));

vi.mock("@checkin/s-ingest-core", () => ({
  prisma: { __fake: true },
  loadDbConfig: vi.fn(() => ({ storeId: "configured-store" })),
  loadShopifyConfig: vi.fn(() => ({ endpoint: "https://x/graphql.json", adminToken: "t", cutoverDate: "2026-01-01" })),
  reapStaleRuns: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  ConcurrentRunError,
}));

vi.mock("../../src/shopify/client.js", () => ({ createShopifyClient: vi.fn(() => ({ request: vi.fn(), endpoint: "e" })) }));
vi.mock("../../src/sync/store.js", () => ({ ensureStore: vi.fn() }));
vi.mock("../../src/sync/incremental.js", () => ({ runIncremental: vi.fn() }));
vi.mock("../../src/sync/backfill.js", () => ({ runBackfill: vi.fn() }));
vi.mock("../../src/monitoring.js", () => ({ buildHeartbeatSink: vi.fn(() => undefined) }));

import { handler } from "../../src/handler.js";
import { prisma, reapStaleRuns, loadDbConfig } from "@checkin/s-ingest-core";
import { buildHeartbeatSink } from "../../src/monitoring.js";
import { ensureStore } from "../../src/sync/store.js";
import { runIncremental } from "../../src/sync/incremental.js";
import { runBackfill } from "../../src/sync/backfill.js";

const order: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  order.length = 0;
  vi.mocked(reapStaleRuns).mockImplementation(async () => {
    order.push("reap");
    return 0;
  });
  vi.mocked(ensureStore).mockImplementation(async () => {
    order.push("ensureStore");
    return { storeId: "live-store", shopGid: "gid://shopify/Shop/1", numericId: "1", name: "Shop" };
  });
  vi.mocked(runIncremental).mockResolvedValue({ orders: 1, payouts: 0, balanceTransactions: 0 });
  vi.mocked(runBackfill).mockResolvedValue({ ordersBulk: { action: "NONE" }, payouts: 0, balanceTransactions: 0 });
});

it("defaults to an incremental run and returns its result", async () => {
  const res = await handler({});
  expect(res).toEqual({ orders: 1, payouts: 0, balanceTransactions: 0 });
  expect(runIncremental).toHaveBeenCalledTimes(1);
  expect(runBackfill).not.toHaveBeenCalled();
});

it("routes mode=backfill to runBackfill", async () => {
  await handler({ mode: "backfill" });
  expect(runBackfill).toHaveBeenCalledTimes(1);
  expect(runIncremental).not.toHaveBeenCalled();
});

it("reaps stale runs before resolving the store, and uses the configured store id as the seed", async () => {
  await handler({});
  expect(order).toEqual(["reap", "ensureStore"]);
  expect(vi.mocked(ensureStore).mock.calls[0][2]).toBe("configured-store");
  expect(loadDbConfig).toHaveBeenCalled();
});

it("hands the reaper the heartbeat sink, so the watchdog hears about killed runs", async () => {
  const sink = vi.fn();
  vi.mocked(buildHeartbeatSink).mockReturnValueOnce(sink);
  await handler({});
  expect(reapStaleRuns).toHaveBeenCalledWith(prisma, sink);
});

it("runs on the live store id, not the configured one", async () => {
  await handler({});
  // runIncremental(prisma, client, storeId, cfg, heartbeat) — storeId is the resolved live value
  expect(vi.mocked(runIncremental).mock.calls[0][2]).toBe("live-store");
});

it("swallows ConcurrentRunError into a benign skip result", async () => {
  vi.mocked(runIncremental).mockRejectedValue(new ConcurrentRunError());
  const res = await handler({});
  expect(res).toMatchObject({ skipped: true, mode: "incremental" });
  expect(res.reason).toMatch(/already in progress/);
});

it("rethrows any other error", async () => {
  vi.mocked(runIncremental).mockRejectedValue(new Error("boom"));
  await expect(handler({})).rejects.toThrow("boom");
});

it("rejects an unknown mode at the Zod boundary", async () => {
  await expect(handler({ mode: "sideways" })).rejects.toThrow();
  expect(reapStaleRuns).not.toHaveBeenCalled(); // failed before doing any work
});
