/**
 * Integration tests for withSyncRun (real Postgres) — the run-bookkeeping + heartbeat +
 * concurrency-guard wrapper. These encode guarantees that are otherwise only asserted by
 * prose comments: terminal status is always written, a heartbeat failure can't break a run,
 * ADMIN runs never push freshness, and a run that loses the advisory lock leaves no row.
 * Skipped unless SHOPIFY_READ_DATABASE_URL is set.
 */
import { it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "../../src/db/client.js";
import { withSyncRun, type RunHeartbeat } from "../../src/sync/run.js";
import { withAdvisoryLock, ConcurrentRunError } from "../../src/sync/locks.js";
import { SyncKind, SyncStatus } from "../../src/generated/prisma/client.js";
import { describeDb } from "../helpers/db.js";

const STORE = "syncrun-test.myshopify.com";

const latestRun = () => prisma.syncRun.findFirst({ where: { storeId: STORE }, orderBy: { id: "desc" } });

describeDb("withSyncRun", () => {
  beforeEach(async () => {
    await prisma.syncRun.deleteMany({ where: { storeId: STORE } });
  });
  afterAll(async () => {
    await prisma.syncRun.deleteMany({ where: { storeId: STORE } });
    await prisma.$disconnect();
  });

  it("records a COMPLETED run with its counts and a finishedAt", async () => {
    const counts = await withSyncRun(prisma, STORE, SyncKind.INCREMENTAL, "orders", async () => ({ processed: 3 }));
    expect(counts).toEqual({ processed: 3 });

    const row = await latestRun();
    expect(row?.status).toBe(SyncStatus.COMPLETED);
    expect(row?.finishedAt).not.toBeNull();
    expect(row?.counts).toMatchObject({ processed: 3 });
  });

  it("records a FAILED run with the error message and rethrows", async () => {
    await expect(
      withSyncRun(prisma, STORE, SyncKind.INCREMENTAL, "orders", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const row = await latestRun();
    expect(row?.status).toBe(SyncStatus.FAILED);
    expect(row?.error).toBe("boom");
    expect(row?.finishedAt).not.toBeNull();
  });

  it("records partial counts on a FAILED run when fn attaches partialCounts to the error", async () => {
    await expect(
      withSyncRun(prisma, STORE, SyncKind.ADMIN, "replay", async () => {
        // Mimics a row-by-row replay that committed some work, then died mid-stream.
        throw Object.assign(new Error("died mid-stream"), {
          partialCounts: { processed: 42, distinctGids: 7, lastCommittedId: "123", failed: true },
        });
      }),
    ).rejects.toThrow("died mid-stream");

    const row = await latestRun();
    expect(row?.status).toBe(SyncStatus.FAILED);
    expect(row?.error).toBe("died mid-stream");
    expect(row?.counts).toMatchObject({ processed: 42, distinctGids: 7, lastCommittedId: "123", failed: true });
  });

  it("fires the heartbeat on a DATA run's terminal transition (COMPLETED)", async () => {
    const beats: RunHeartbeat[] = [];
    await withSyncRun(prisma, STORE, SyncKind.INCREMENTAL, "orders", async () => ({ processed: 1 }), {
      heartbeat: (b) => void beats.push(b),
    });
    expect(beats).toHaveLength(1);
    expect(beats[0]).toMatchObject({ storeId: STORE, kind: SyncKind.INCREMENTAL, status: SyncStatus.COMPLETED });
  });

  it("fires the heartbeat with FAILED when a DATA run throws", async () => {
    const beats: RunHeartbeat[] = [];
    await expect(
      withSyncRun(prisma, STORE, SyncKind.INCREMENTAL, "orders", async () => {
        throw new Error("kaboom");
      }, { heartbeat: (b) => void beats.push(b) }),
    ).rejects.toThrow("kaboom");
    expect(beats).toHaveLength(1);
    expect(beats[0]).toMatchObject({ status: SyncStatus.FAILED, error: "kaboom" });
  });

  it("redacts secrets from the stored error and the heartbeat", async () => {
    const beats: RunHeartbeat[] = [];
    await expect(
      withSyncRun(prisma, STORE, SyncKind.INCREMENTAL, "orders", async () => {
        throw new Error("401 from X-Shopify-Access-Token: shpat_0123456789abcdef");
      }, { heartbeat: (b) => void beats.push(b) }),
    ).rejects.toThrow();
    expect((await latestRun())?.error).toBe("401 from X-Shopify-Access-Token: [redacted]");
    expect(beats[0]).toMatchObject({ error: "401 from X-Shopify-Access-Token: [redacted]" });
  });

  it("never fires a heartbeat for an ADMIN run (replay/reset must not reset freshness)", async () => {
    const beats: RunHeartbeat[] = [];
    await withSyncRun(prisma, STORE, SyncKind.ADMIN, "reset-watermark", async () => ({ ok: true }), {
      heartbeat: (b) => void beats.push(b),
    });
    expect(beats).toHaveLength(0);
    expect((await latestRun())?.status).toBe(SyncStatus.COMPLETED);
  });

  it("does not let a heartbeat failure break the run", async () => {
    const counts = await withSyncRun(prisma, STORE, SyncKind.INCREMENTAL, "orders", async () => ({ processed: 5 }), {
      heartbeat: () => {
        throw new Error("monitoring DB down");
      },
    });
    expect(counts).toEqual({ processed: 5 });
    expect((await latestRun())?.status).toBe(SyncStatus.COMPLETED);
  });

  it("throws ConcurrentRunError and creates NO run row when the advisory lock is held", async () => {
    const before = await prisma.syncRun.count({ where: { storeId: STORE } });
    await withAdvisoryLock(`sync_run:${STORE}`, async () => {
      // A second run for the same store cannot take the lock — it must fail fast,
      // BEFORE any sync_run row is created (so a skip leaves no FAILED row behind).
      await expect(
        withSyncRun(prisma, STORE, SyncKind.INCREMENTAL, "orders", async () => ({ processed: 1 })),
      ).rejects.toBeInstanceOf(ConcurrentRunError);
    });
    expect(await prisma.syncRun.count({ where: { storeId: STORE } })).toBe(before);
  });
});
