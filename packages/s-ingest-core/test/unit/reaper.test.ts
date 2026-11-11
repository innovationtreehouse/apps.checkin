/**
 * The reaper's failure beat: what the watchdog sees for a killed run, and that neither a
 * live run nor a monitoring failure produces a false alarm or stops the reaper.
 */
import { it, expect, vi, beforeEach } from "vitest";
import type { PrismaClient } from "../../src/db/client.js";
import { SyncKind, SyncStatus } from "../../src/generated/prisma/client.js";
import { ConcurrentRunError, withAdvisoryLock } from "../../src/sync/locks.js";
import { reapStaleRuns, type RunHeartbeat } from "../../src/sync/run.js";

vi.mock("../../src/sync/locks.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/sync/locks.js")>()),
  withAdvisoryLock: vi.fn(),
}));

const STORE = "reaper-test.myshopify.com";
const older = new Date("2026-10-30T10:00:00Z");
const newer = new Date("2026-10-30T11:00:00Z");

const prismaReaping = (rows: { storeId: string; kind: SyncKind; startedAt: Date }[]) =>
  ({ syncRun: { updateManyAndReturn: vi.fn(async () => rows) } }) as unknown as PrismaClient;

beforeEach(() => {
  vi.mocked(withAdvisoryLock).mockReset();
  vi.mocked(withAdvisoryLock).mockImplementation((_key, fn) => fn() as never);
});

it("pushes an ABANDONED beat per data run, oldest first, dated when the run started", async () => {
  const beats: RunHeartbeat[] = [];
  const prisma = prismaReaping([
    { storeId: STORE, kind: SyncKind.INCREMENTAL, startedAt: newer },
    { storeId: STORE, kind: SyncKind.BACKFILL, startedAt: older },
  ]);

  expect(await reapStaleRuns(prisma, (b) => void beats.push(b))).toBe(2);

  expect(beats.map((b) => [b.status, b.kind, b.finishedAt])).toEqual([
    [SyncStatus.ABANDONED, SyncKind.BACKFILL, older],
    [SyncStatus.ABANDONED, SyncKind.INCREMENTAL, newer],
  ]);
  expect(beats[0].error).toMatch(/^reaped:/);
  expect(withAdvisoryLock).toHaveBeenCalledWith(`sync_run:${STORE}`, expect.any(Function));
});

it("pushes no beat for a reaped ADMIN run", async () => {
  const sink = vi.fn();
  const prisma = prismaReaping([{ storeId: STORE, kind: SyncKind.ADMIN, startedAt: older }]);

  expect(await reapStaleRuns(prisma, sink)).toBe(1);
  expect(sink).not.toHaveBeenCalled();
});

it("pushes no beat while the store's run lock is held by a live run", async () => {
  const sink = vi.fn();
  vi.mocked(withAdvisoryLock).mockRejectedValue(new ConcurrentRunError(`sync_run:${STORE}`));
  const prisma = prismaReaping([{ storeId: STORE, kind: SyncKind.INCREMENTAL, startedAt: older }]);

  expect(await reapStaleRuns(prisma, sink)).toBe(1);
  expect(sink).not.toHaveBeenCalled();
});

it.each([
  ["the sink throws", () => vi.fn().mockRejectedValue(new Error("monitoring down"))],
  [
    "the lock connection fails",
    () => {
      vi.mocked(withAdvisoryLock).mockRejectedValue(new Error("connection refused"));
      return vi.fn();
    },
  ],
])("still reaps every run when %s", async (_name, makeSink) => {
  const sink = makeSink();
  const prisma = prismaReaping([
    { storeId: STORE, kind: SyncKind.INCREMENTAL, startedAt: older },
    { storeId: STORE, kind: SyncKind.INCREMENTAL, startedAt: newer },
  ]);

  await expect(reapStaleRuns(prisma, sink)).resolves.toBe(2);
});
