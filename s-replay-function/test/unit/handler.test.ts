/**
 * DB-free behavioral tests for the Lambda entry point. We mock the replay ops
 * (../../src/replay.js) and the s-ingest-core wiring (prisma sentinel, loadDbConfig,
 * logger), keeping the REAL ObjectType + ConcurrentRunError so enum mapping and the
 * skip path are exercised against the genuine values. The mock fns are created with
 * vi.hoisted so they exist before the hoisted vi.mock factories run.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  replay: vi.fn(),
  resetWatermark: vi.fn(),
  reingestBulk: vi.fn(),
  loadDbConfig: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  // Opaque sentinel — the handler must hand the SAME prisma reference to each op.
  prismaSentinel: { __brand: "prisma-sentinel" as const },
}));

vi.mock("../../src/replay.js", () => ({
  replay: mocks.replay,
  resetWatermark: mocks.resetWatermark,
  reingestBulk: mocks.reingestBulk,
}));

vi.mock("@checkin/s-ingest-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@checkin/s-ingest-core")>();
  return {
    ...actual, // keep real ObjectType, ConcurrentRunError, SyncKind, …
    prisma: mocks.prismaSentinel,
    loadDbConfig: mocks.loadDbConfig,
    logger: { warn: mocks.warn, info: mocks.info, error: mocks.error },
  };
});

import { handler } from "../../src/handler.js";
import { ObjectType, ConcurrentRunError } from "@checkin/s-ingest-core";

const CONFIG_STORE = "config-default.myshopify.com";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadDbConfig.mockReturnValue({ storeId: CONFIG_STORE, databaseUrl: "postgres://unused" });
  mocks.replay.mockResolvedValue({ processed: 0, distinctGids: 0 });
  mocks.resetWatermark.mockResolvedValue({ objectTypes: [], to: null });
  mocks.reingestBulk.mockResolvedValue({ exports: 0, ingested: 0 });
});

describe("handler() dispatch + arg mapping", () => {
  it("replay: defaults storeId from loadDbConfig, maps objectType→enum, since→Date, passes gid", async () => {
    await handler({
      mode: "replay",
      objectType: "ORDER",
      gid: "gid://shopify/Order/1",
      since: "2026-01-01T00:00:00Z",
      actor: "ops:jane",
      reason: "reproject after fix",
    });

    expect(mocks.replay).toHaveBeenCalledTimes(1);
    expect(mocks.resetWatermark).not.toHaveBeenCalled();
    expect(mocks.reingestBulk).not.toHaveBeenCalled();

    const [client, args] = mocks.replay.mock.calls[0];
    expect(client).toBe(mocks.prismaSentinel);
    expect(args.storeId).toBe(CONFIG_STORE);
    expect(args.objectType).toBe(ObjectType.ORDER);
    expect(args.gid).toBe("gid://shopify/Order/1");
    expect(args.sinceOccurredAt).toBeInstanceOf(Date);
    expect(args.sinceOccurredAt.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(args.actor).toBe("ops:jane");
    expect(args.reason).toBe("reproject after fix");
  });

  it("replay: explicit storeId wins (loadDbConfig untouched); omitted objectType/since/gid → undefined", async () => {
    await handler({ mode: "replay", storeId: "explicit.myshopify.com", scope: "all", actor: "a", reason: "r" });

    const [, args] = mocks.replay.mock.calls[0];
    expect(args.storeId).toBe("explicit.myshopify.com");
    expect(args.objectType).toBeUndefined();
    expect(args.sinceOccurredAt).toBeUndefined();
    expect(args.gid).toBeUndefined();
    expect(mocks.loadDbConfig).not.toHaveBeenCalled();
  });

  it("reset-watermark: maps objectType→enum and to→Date", async () => {
    await handler({
      mode: "reset-watermark",
      objectType: "PAYOUT",
      to: "2026-03-01T00:00:00Z",
      actor: "a",
      reason: "r",
    });

    expect(mocks.resetWatermark).toHaveBeenCalledTimes(1);
    expect(mocks.replay).not.toHaveBeenCalled();
    const [client, args] = mocks.resetWatermark.mock.calls[0];
    expect(client).toBe(mocks.prismaSentinel);
    expect(args.objectType).toBe(ObjectType.PAYOUT);
    expect(args.to).toBeInstanceOf(Date);
    expect(args.to.toISOString()).toBe("2026-03-01T00:00:00.000Z");
  });

  it("reset-watermark: omitted `to` and `objectType` map to null / undefined (reset all types)", async () => {
    await handler({ mode: "reset-watermark", scope: "all", actor: "a", reason: "r" });

    const [, args] = mocks.resetWatermark.mock.calls[0];
    expect(args.to).toBeNull();
    expect(args.objectType).toBeUndefined();
  });

  it("reingest-bulk: maps since→sinceFetchedAt Date and passes bulkOperationId", async () => {
    await handler({
      mode: "reingest-bulk",
      since: "2026-01-01T00:00:00Z",
      bulkOperationId: "gid://shopify/BulkOperation/9",
      actor: "a",
      reason: "r",
    });

    expect(mocks.reingestBulk).toHaveBeenCalledTimes(1);
    const [client, args] = mocks.reingestBulk.mock.calls[0];
    expect(client).toBe(mocks.prismaSentinel);
    expect(args.sinceFetchedAt).toBeInstanceOf(Date);
    expect(args.sinceFetchedAt.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(args.bulkOperationId).toBe("gid://shopify/BulkOperation/9");
  });
});

describe("handler() error handling", () => {
  it("maps a ConcurrentRunError to a benign { skipped:true } and logs a warning", async () => {
    mocks.replay.mockRejectedValueOnce(new ConcurrentRunError("sync_run:some-store"));

    const res = await handler({ mode: "replay", storeId: "s", objectType: "ORDER", actor: "a", reason: "r" });

    expect(res.skipped).toBe(true);
    expect(res.mode).toBe("replay");
    expect(String(res.reason)).toMatch(/another sync run/i);
    expect(mocks.warn).toHaveBeenCalledTimes(1);
  });

  it("rethrows any non-ConcurrentRunError error (and does not log the skip warning)", async () => {
    mocks.reingestBulk.mockRejectedValueOnce(new Error("boom"));

    await expect(handler({ mode: "reingest-bulk", storeId: "s", since: "2026-01-01T00:00:00Z", actor: "a", reason: "r" })).rejects.toThrow("boom");
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it("rejects a schema-invalid event before any dispatch", async () => {
    // Missing the required actor/reason → Zod throws inside handler before the switch.
    await expect(handler({ mode: "replay" })).rejects.toThrow();
    expect(mocks.replay).not.toHaveBeenCalled();
    expect(mocks.resetWatermark).not.toHaveBeenCalled();
    expect(mocks.reingestBulk).not.toHaveBeenCalled();
  });
});

describe("handler() unfiltered calls", () => {
  it.each(["replay", "reset-watermark", "reingest-bulk"] as const)(
    "%s: refuses an unfiltered call without scope:\"all\" before any dispatch",
    async (mode) => {
      await expect(handler({ mode, storeId: "s", actor: "a", reason: "r" })).rejects.toThrow(/scope/);
      expect(mocks.replay).not.toHaveBeenCalled();
      expect(mocks.resetWatermark).not.toHaveBeenCalled();
      expect(mocks.reingestBulk).not.toHaveBeenCalled();
    },
  );
});
