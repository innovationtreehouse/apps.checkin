/**
 * The sync stream building blocks (streams.ts): the exact Admin-API filter strings,
 * ingestStream's count / inserted / newest-timestamp accounting, and watermark
 * advancement — including the quiet-store case where an empty stream advances the
 * watermark by `null` (i.e. not at all).
 *
 * Core (ingestNode / readSinceIso / advanceWatermark / enums / logger) and the
 * Shopify fetchers are mocked at the module boundary so this is a pure unit test.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

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

import { ingestStream, syncOrders, syncPayouts, syncBalanceTransactions } from "../../src/sync/streams.js";
import { ingestNode, readSinceIso, advanceWatermark, EventSource, ObjectType } from "@checkin/s-ingest-core";
import { fetchOrders, fetchPayouts, fetchBalanceTransactions } from "../../src/shopify/fetchers.js";
import { fakeClient } from "../helpers/fakeClient.js";
import { prismaSentinel } from "../helpers/fakePrisma.js";

async function* gen<T>(...nodes: T[]): AsyncGenerator<T> {
  for (const n of nodes) yield n;
}

const cfg = { cutoverDate: "2026-01-01" } as never;
const client = fakeClient({});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(ingestNode).mockResolvedValue({
    rawEventId: 1n,
    shopifyGid: "g",
    occurredAt: new Date("2026-05-01T00:00:00Z"),
    inserted: true,
  });
  vi.mocked(advanceWatermark).mockResolvedValue(undefined);
});

describe("ingestStream accounting", () => {
  it("counts nodes, tracks inserts, and reports the newest occurredAt regardless of order", async () => {
    const older = new Date("2026-02-01T00:00:00Z");
    const newest = new Date("2026-04-01T00:00:00Z");
    const middle = new Date("2026-03-01T00:00:00Z");
    vi.mocked(ingestNode)
      .mockResolvedValueOnce({ rawEventId: 1n, shopifyGid: "a", occurredAt: older, inserted: true })
      .mockResolvedValueOnce({ rawEventId: 2n, shopifyGid: "b", occurredAt: newest, inserted: false })
      .mockResolvedValueOnce({ rawEventId: 3n, shopifyGid: "c", occurredAt: middle, inserted: true });

    const summary = await ingestStream(prismaSentinel, "store-1", ObjectType.ORDER, EventSource.INCREMENTAL, gen({}, {}, {}));

    expect(summary).toEqual({ count: 3, inserted: 2, maxOccurredAt: newest });
    expect(ingestNode).toHaveBeenCalledTimes(3);
    expect(vi.mocked(ingestNode).mock.calls[0][1]).toMatchObject({
      storeId: "store-1",
      objectType: ObjectType.ORDER,
      source: EventSource.INCREMENTAL,
    });
  });

  it("returns zero counts and null maxOccurredAt for an empty stream", async () => {
    expect(await ingestStream(prismaSentinel, "s", ObjectType.PAYOUT, EventSource.BACKFILL, gen())).toEqual({
      count: 0,
      inserted: 0,
      maxOccurredAt: null,
    });
    expect(ingestNode).not.toHaveBeenCalled();
  });

  it("forwards the syncRunId to ingestNode when provided", async () => {
    await ingestStream(prismaSentinel, "s", ObjectType.ORDER, EventSource.INCREMENTAL, gen({}), 42n);
    expect(vi.mocked(ingestNode).mock.calls[0][1]).toMatchObject({ syncRunId: 42n });
  });
});

describe("syncOrders", () => {
  it("filters on updated_at since the watermark with status:any and advances the watermark", async () => {
    vi.mocked(readSinceIso).mockResolvedValue("2026-02-01T00:00:00.000Z");
    const occurredAt = new Date("2026-05-01T00:00:00Z");
    vi.mocked(ingestNode).mockResolvedValue({ rawEventId: 1n, shopifyGid: "g", occurredAt, inserted: true });
    vi.mocked(fetchOrders).mockReturnValue(gen({ id: "o1" }));

    const summary = await syncOrders(prismaSentinel, client, "store-1", cfg, EventSource.INCREMENTAL, 7n);

    expect(vi.mocked(fetchOrders).mock.calls[0][1]).toBe("updated_at:>='2026-02-01T00:00:00.000Z' status:any");
    expect(advanceWatermark).toHaveBeenCalledWith(prismaSentinel, "store-1", ObjectType.ORDER, occurredAt);
    expect(summary.count).toBe(1);
  });
});

describe("syncPayouts", () => {
  it("filters on issued_at since the watermark", async () => {
    vi.mocked(readSinceIso).mockResolvedValue("2026-02-01T00:00:00.000Z");
    vi.mocked(fetchPayouts).mockReturnValue(gen({ id: "p1" }));

    await syncPayouts(prismaSentinel, client, "store-1", cfg, EventSource.BACKFILL);

    expect(vi.mocked(fetchPayouts).mock.calls[0][1]).toBe("issued_at:>='2026-02-01T00:00:00.000Z'");
    expect(advanceWatermark).toHaveBeenCalledWith(prismaSentinel, "store-1", ObjectType.PAYOUT, expect.anything());
  });
});

describe("syncBalanceTransactions", () => {
  it("filters on processed_at since the watermark", async () => {
    vi.mocked(readSinceIso).mockResolvedValue("2026-02-01T00:00:00.000Z");
    vi.mocked(fetchBalanceTransactions).mockReturnValue(gen({ id: "b1" }));

    await syncBalanceTransactions(prismaSentinel, client, "store-1", cfg, EventSource.INCREMENTAL);

    expect(vi.mocked(fetchBalanceTransactions).mock.calls[0][1]).toBe("processed_at:>='2026-02-01T00:00:00.000Z'");
    expect(advanceWatermark).toHaveBeenCalledWith(prismaSentinel, "store-1", ObjectType.BALANCE_TXN, expect.anything());
  });

  it("advances the watermark by null on a quiet store (empty stream) so it does not move", async () => {
    vi.mocked(readSinceIso).mockResolvedValue("2026-02-01T00:00:00.000Z");
    vi.mocked(fetchBalanceTransactions).mockReturnValue(gen());

    await syncBalanceTransactions(prismaSentinel, client, "store-1", cfg, EventSource.INCREMENTAL);

    expect(advanceWatermark).toHaveBeenCalledWith(prismaSentinel, "store-1", ObjectType.BALANCE_TXN, null);
  });
});
