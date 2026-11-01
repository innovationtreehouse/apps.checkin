/**
 * Integration test for the stale-run reaper. Skipped unless SHOPIFY_READ_DATABASE_URL is set.
 */
import { it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "../../src/db/client.js";
import { reapStaleRuns } from "../../src/sync/run.js";
import { SyncKind, SyncStatus } from "../../src/generated/prisma/client.js";
import { describeDb } from "../helpers/db.js";

const STORE = "reaper-test.myshopify.com";

describeDb("reapStaleRuns", () => {
  beforeEach(async () => {
    await prisma.syncRun.deleteMany({ where: { storeId: STORE } });
  });
  afterAll(async () => {
    await prisma.syncRun.deleteMany({ where: { storeId: STORE } });
    await prisma.$disconnect();
  });

  const mkRun = (status: SyncStatus, startedAt: Date) =>
    prisma.syncRun.create({
      data: { storeId: STORE, kind: SyncKind.INCREMENTAL, objectScope: "test", status, startedAt },
      select: { id: true },
    });

  it("relabels only RUNNING runs older than the threshold", async () => {
    const old = await mkRun(SyncStatus.RUNNING, new Date(Date.now() - 30 * 60 * 1000)); // 30m ago
    const recent = await mkRun(SyncStatus.RUNNING, new Date()); // just now
    const done = await mkRun(SyncStatus.COMPLETED, new Date(Date.now() - 60 * 60 * 1000));

    const count = await reapStaleRuns(prisma);
    expect(count).toBe(1);

    const oldRow = await prisma.syncRun.findUnique({ where: { id: old.id } });
    const recentRow = await prisma.syncRun.findUnique({ where: { id: recent.id } });
    const doneRow = await prisma.syncRun.findUnique({ where: { id: done.id } });

    expect(oldRow?.status).toBe(SyncStatus.ABANDONED);
    expect(oldRow?.finishedAt).not.toBeNull();
    expect(recentRow?.status).toBe(SyncStatus.RUNNING); // too recent — left alone
    expect(doneRow?.status).toBe(SyncStatus.COMPLETED); // terminal — untouched
  });

  it("is a no-op when nothing is stale", async () => {
    await mkRun(SyncStatus.RUNNING, new Date());
    expect(await reapStaleRuns(prisma)).toBe(0);
  });
});
