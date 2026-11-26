/**
 * The recent-window re-read (rereadPayouts / rereadBalanceTransactions), driven against
 * an in-memory store and copy. The store answers the real `issued_at` / `processed_at`
 * filters; the copy stands in for core's ingest (a byte-identical node appends nothing)
 * and watermark (forward-only). Each run is the incremental order: forward pull, then
 * re-read.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@checkin/s-ingest-core", () => ({
  EventSource: { INCREMENTAL: "INCREMENTAL", BACKFILL: "BACKFILL" },
  ObjectType: { ORDER: "ORDER", PAYOUT: "PAYOUT", BALANCE_TXN: "BALANCE_TXN" },
  ingestNode: vi.fn(),
  readSinceIso: vi.fn(),
  advanceWatermark: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../src/shopify/fetchers.js", () => ({
  fetchOrders: vi.fn(),
  fetchPayouts: vi.fn(),
  fetchBalanceTransactions: vi.fn(),
}));

import {
  REREAD_WINDOW_DAYS,
  rereadStream,
  rereadPayouts,
  rereadBalanceTransactions,
  syncPayouts,
  syncBalanceTransactions,
} from "../../src/sync/streams.js";
import { ingestNode, readSinceIso, advanceWatermark, logger, EventSource, ObjectType } from "@checkin/s-ingest-core";
import { fetchPayouts, fetchBalanceTransactions } from "../../src/shopify/fetchers.js";
import { fakeClient } from "../helpers/fakeClient.js";
import { prismaSentinel } from "../helpers/fakePrisma.js";

interface PayoutNode {
  id: string;
  issuedAt: string;
  status: string;
}

interface TxnNode {
  id: string;
  transactionDate: string;
  associatedPayout: { id: string } | null;
}

const cfg = { cutoverDate: "2026-01-01" } as never;
const client = fakeClient({});
const NEVER = new Date("2100-01-01T00:00:00Z");

let storePayouts: PayoutNode[];
let storeTxns: TxnNode[];
let copy: Map<string, string>;
let rawAppends: number;
let watermarks: Map<string, Date>;

function sinceOf(filter: string): string {
  const match = /:>='([^']+)'/.exec(filter);
  if (!match) throw new Error(`unexpected filter ${filter}`);
  return match[1];
}

/** The store's answer to a filter: oldest first by default, newest first when asked. */
async function* matching<T>(
  nodes: T[],
  at: (n: T) => string,
  filter: string,
  opts: { newestFirst?: boolean } = {},
): AsyncGenerator<T> {
  const since = new Date(sinceOf(filter));
  const inWindow = nodes.filter((n) => new Date(at(n)) >= since);
  if (opts.newestFirst) inWindow.reverse();
  for (const n of inWindow) yield structuredClone(n);
}

function copied<T>(gid: string): T {
  const json = copy.get(gid);
  if (!json) throw new Error(`${gid} is not in the copy`);
  return JSON.parse(json) as T;
}

/** One incremental run's payout and balance-transaction steps, at `now`. */
async function run(now: string): Promise<void> {
  vi.setSystemTime(new Date(now));
  await syncPayouts(prismaSentinel, client, "store-1", cfg, EventSource.INCREMENTAL, 1n);
  await syncBalanceTransactions(prismaSentinel, client, "store-1", cfg, EventSource.INCREMENTAL, 1n);
  await rereadPayouts(prismaSentinel, client, "store-1", NEVER, 1n);
  await rereadBalanceTransactions(prismaSentinel, client, "store-1", NEVER, 1n);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  storePayouts = [];
  storeTxns = [];
  copy = new Map();
  rawAppends = 0;
  watermarks = new Map();

  vi.mocked(fetchPayouts).mockImplementation((_c, filter, opts) =>
    matching(storePayouts, (p) => p.issuedAt, filter, opts),
  );
  vi.mocked(fetchBalanceTransactions).mockImplementation((_c, filter, opts) =>
    matching(storeTxns, (t) => t.transactionDate, filter, opts),
  );
  vi.mocked(ingestNode).mockImplementation(async (_p, { objectType, node }) => {
    const n = node as Partial<PayoutNode & TxnNode> & { id: string };
    const json = JSON.stringify(node);
    const inserted = copy.get(n.id) !== json;
    if (inserted) {
      copy.set(n.id, json);
      rawAppends++;
    }
    const at = objectType === ObjectType.PAYOUT ? n.issuedAt : n.transactionDate;
    return { rawEventId: BigInt(rawAppends), shopifyGid: n.id, occurredAt: at ? new Date(at) : null, inserted, payloadChanged: inserted };
  });
  vi.mocked(readSinceIso).mockImplementation(async (_p, _s, objectType, cutover) =>
    (watermarks.get(objectType) ?? new Date(cutover)).toISOString(),
  );
  vi.mocked(advanceWatermark).mockImplementation(async (_p, _s, objectType, candidate) => {
    const current = watermarks.get(objectType);
    if (candidate && (!current || candidate > current)) watermarks.set(objectType, candidate);
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("re-reading the recent window", () => {
  it("is a named 30-day window on issued_at and processed_at", async () => {
    vi.setSystemTime(new Date("2026-11-20T00:00:00Z"));
    await rereadPayouts(prismaSentinel, client, "store-1", NEVER);
    await rereadBalanceTransactions(prismaSentinel, client, "store-1", NEVER);

    expect(REREAD_WINDOW_DAYS).toBe(30);
    expect(vi.mocked(fetchPayouts).mock.calls[0][1]).toBe("issued_at:>='2026-10-21T00:00:00.000Z'");
    expect(vi.mocked(fetchBalanceTransactions).mock.calls[0][1]).toBe("processed_at:>='2026-10-21T00:00:00.000Z'");
  });

  it("reads the window newest first, while the forward pull keeps the default order", async () => {
    await run("2026-11-20T00:00:00Z");

    const [forwardPayouts, rereadPayoutsCall] = vi.mocked(fetchPayouts).mock.calls;
    const [forwardTxns, rereadTxnsCall] = vi.mocked(fetchBalanceTransactions).mock.calls;
    expect(forwardPayouts[2]).toBeUndefined();
    expect(forwardTxns[2]).toBeUndefined();
    expect(rereadPayoutsCall[2]).toEqual({ newestFirst: true });
    expect(rereadTxnsCall[2]).toEqual({ newestFirst: true });
  });

  it("marks a payout paid that was read in transit and paid at the store after a newer payout was read", async () => {
    storePayouts.push({ id: "p1", issuedAt: "2026-11-10T00:00:00Z", status: "IN_TRANSIT" });
    await run("2026-11-10T12:00:00Z");
    storePayouts.push({ id: "p2", issuedAt: "2026-11-12T00:00:00Z", status: "SCHEDULED" });
    await run("2026-11-12T12:00:00Z");

    storePayouts[0].status = "PAID";
    vi.setSystemTime(new Date("2026-11-14T12:00:00Z"));
    await syncPayouts(prismaSentinel, client, "store-1", cfg, EventSource.INCREMENTAL);
    expect(copied<PayoutNode>("p1").status).toBe("IN_TRANSIT");

    await rereadPayouts(prismaSentinel, client, "store-1", NEVER);
    expect(copied<PayoutNode>("p1").status).toBe("PAID");
    expect(logger.info).toHaveBeenCalledWith("re-read found a change", { objectType: "PAYOUT", shopifyGid: "p1" });
  });

  it("gives a transaction the payout the store assigns it after the transaction was read", async () => {
    storeTxns.push({ id: "t1", transactionDate: "2026-11-10T00:00:00Z", associatedPayout: null });
    await run("2026-11-10T12:00:00Z");
    storeTxns.push({ id: "t2", transactionDate: "2026-11-12T00:00:00Z", associatedPayout: null });
    await run("2026-11-12T12:00:00Z");

    storeTxns[0].associatedPayout = { id: "p1" };
    await run("2026-11-14T12:00:00Z");

    expect(copied<TxnNode>("t1").associatedPayout).toEqual({ id: "p1" });
    expect(copied<TxnNode>("t2").associatedPayout).toBeNull();
  });

  it("writes nothing new when nothing changed at the store", async () => {
    storePayouts.push({ id: "p1", issuedAt: "2026-11-10T00:00:00Z", status: "PAID" });
    storeTxns.push({ id: "t1", transactionDate: "2026-11-10T00:00:00Z", associatedPayout: { id: "p1" } });
    await run("2026-11-10T12:00:00Z");
    const appendsAfterFirstRun = rawAppends;

    vi.setSystemTime(new Date("2026-11-11T12:00:00Z"));
    const payouts = await rereadPayouts(prismaSentinel, client, "store-1", NEVER);
    const txns = await rereadBalanceTransactions(prismaSentinel, client, "store-1", NEVER);

    expect(payouts).toEqual({ count: 1, changed: 0, stopped: false });
    expect(txns).toEqual({ count: 1, changed: 0, stopped: false });
    expect(rawAppends).toBe(appendsAfterFirstRun);
  });

  it("does not count a store read that only confirms a hand-made version as a change", async () => {
    vi.setSystemTime(new Date("2026-11-20T00:00:00Z"));
    storePayouts.push({ id: "p1", issuedAt: "2026-11-10T00:00:00Z", status: "PAID" });
    vi.mocked(ingestNode).mockResolvedValueOnce({
      rawEventId: 2n,
      shopifyGid: "p1",
      occurredAt: new Date("2026-11-10T00:00:00Z"),
      inserted: true,
      payloadChanged: false,
    });

    const summary = await rereadPayouts(prismaSentinel, client, "store-1", NEVER);

    expect(summary).toEqual({ count: 1, changed: 0, stopped: false });
    expect(logger.info).not.toHaveBeenCalledWith("re-read found a change", expect.anything());
  });

  it("never moves the watermark, so it stays at the newest node the forward pull saw", async () => {
    storePayouts.push({ id: "p1", issuedAt: "2026-11-10T00:00:00Z", status: "IN_TRANSIT" });
    storePayouts.push({ id: "p2", issuedAt: "2026-11-12T00:00:00Z", status: "SCHEDULED" });
    storeTxns.push({ id: "t1", transactionDate: "2026-11-12T00:00:00Z", associatedPayout: null });
    await run("2026-11-12T12:00:00Z");
    const forwardCalls = vi.mocked(advanceWatermark).mock.calls.length;

    storePayouts[0].status = "PAID";
    vi.setSystemTime(new Date("2026-11-14T12:00:00Z"));
    await rereadPayouts(prismaSentinel, client, "store-1", NEVER);
    await rereadBalanceTransactions(prismaSentinel, client, "store-1", NEVER);

    expect(vi.mocked(advanceWatermark).mock.calls.length).toBe(forwardCalls);
    expect(watermarks.get("PAYOUT")).toEqual(new Date("2026-11-12T00:00:00Z"));
    expect(watermarks.get("BALANCE_TXN")).toEqual(new Date("2026-11-12T00:00:00Z"));
  });
});

describe("rereadStream time limit", () => {
  it("reads nothing once the limit has already passed", async () => {
    vi.setSystemTime(new Date("2026-11-20T00:00:00Z"));
    storePayouts.push({ id: "p1", issuedAt: "2026-11-19T00:00:00Z", status: "PAID" });

    const summary = await rereadPayouts(prismaSentinel, client, "store-1", new Date("2026-11-19T23:00:00Z"));

    expect(summary).toEqual({ count: 0, changed: 0, stopped: true });
    expect(ingestNode).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "re-read stopped at its time limit; the next run re-reads the window",
      expect.objectContaining({ objectType: "PAYOUT", stopped: true }),
    );
  });

  it("stops between nodes when the limit passes mid-window, keeping what it read", async () => {
    vi.setSystemTime(new Date("2026-11-20T00:00:00Z"));
    const stopAt = new Date("2026-11-20T00:10:00Z");
    async function* slow(): AsyncGenerator<PayoutNode> {
      yield { id: "a", issuedAt: "2026-11-01T00:00:00Z", status: "PAID" };
      vi.setSystemTime(stopAt);
      yield { id: "b", issuedAt: "2026-11-02T00:00:00Z", status: "PAID" };
    }

    const summary = await rereadStream(prismaSentinel, "store-1", ObjectType.PAYOUT, slow(), stopAt);

    expect(summary).toEqual({ count: 1, changed: 1, stopped: true });
    expect(copy.has("a")).toBe(true);
    expect(copy.has("b")).toBe(false);
  });

  it("reaches the newest transaction in the first run even when every run stops after three reads", async () => {
    for (let day = 1; day <= 10; day++) {
      storeTxns.push({ id: `t${day}`, transactionDate: `2026-11-${String(day).padStart(2, "0")}T00:00:00Z`, associatedPayout: null });
    }
    await run("2026-11-10T12:00:00Z");
    storeTxns[9].associatedPayout = { id: "p1" };

    // Each read takes a minute; the run's limit allows three.
    const ingest = vi.mocked(ingestNode).getMockImplementation();
    if (!ingest) throw new Error("ingestNode has no implementation");
    vi.mocked(ingestNode).mockImplementation(async (...args) => {
      vi.setSystemTime(new Date(Date.now() + 60_000));
      return ingest(...args);
    });
    vi.setSystemTime(new Date("2026-11-11T12:00:00Z"));
    const summary = await rereadBalanceTransactions(prismaSentinel, client, "store-1", new Date("2026-11-11T12:03:00Z"));

    expect(summary).toEqual({ count: 3, changed: 1, stopped: true });
    expect(copied<TxnNode>("t10").associatedPayout).toEqual({ id: "p1" });
  });
});
