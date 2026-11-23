/**
 * The reaper's failure beat: what the watchdog sees for a killed run, and that neither a
 * live run nor a monitoring failure produces a false alarm or stops the reaper.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

type Reapable = { storeId: string; kind: SyncKind; startedAt: Date; status: SyncStatus };

/** A RUNNING row in the reaper's own filter, judged the way Postgres would. */
const matchesReaper = (where: { status: SyncStatus; startedAt: { lt: Date } }, run: Reapable) =>
  run.status === where.status && run.startedAt < where.startedAt.lt;

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

const MINUTE = 60 * 1000;
const NOW = new Date("2026-11-23T12:00:00Z");
const runningSince = (minutes: number): Reapable => ({
  storeId: STORE,
  kind: SyncKind.INCREMENTAL,
  startedAt: new Date(NOW.getTime() - minutes * MINUTE),
  status: SyncStatus.RUNNING,
});

/** The rows a reap would relabel, from the filter it hands the database. */
async function reapedOf(runs: Reapable[]): Promise<Reapable[]> {
  const updateManyAndReturn = vi.fn<(args: { where: { status: SyncStatus; startedAt: { lt: Date } } }) => Promise<never[]>>(async () => []);
  await reapStaleRuns({ syncRun: { updateManyAndReturn } } as unknown as PrismaClient);
  const { where } = updateManyAndReturn.mock.calls[0][0];
  return runs.filter((run) => matchesReaper(where, run));
}

describe("the staleness threshold", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
    delete process.env.SYNC_DEADLINE_MINUTES;
  });

  it("leaves a run 20 minutes in, still inside the 55-minute deadline", async () => {
    expect(await reapedOf([runningSince(20)])).toEqual([]);
  });

  it("leaves a run just past the deadline until the margin has passed too", async () => {
    expect(await reapedOf([runningSince(56)])).toEqual([]);
  });

  it("abandons a run past the deadline and its margin", async () => {
    const dead = runningSince(61);
    expect(await reapedOf([dead, runningSince(20)])).toEqual([dead]);
  });

  it("follows SYNC_DEADLINE_MINUTES, so a longer deadline is never reaped early", async () => {
    process.env.SYNC_DEADLINE_MINUTES = "120";
    const longRun = runningSince(90);
    const dead = runningSince(126);
    expect(await reapedOf([longRun, dead])).toEqual([dead]);
  });
});
