/**
 * Wrap an orchestrated run in a `sync_run` record for observability: one row that
 * captures start/finish, status, counts, and any error.
 */
import type { PrismaClient } from "../db/client.js";
import { SyncKind, SyncStatus } from "../generated/prisma/client.js";
import type { Prisma } from "../generated/prisma/client.js";
import { logger } from "@checkin/telemetry";
import { redactSecrets } from "@checkin/utils";
import { ConcurrentRunError, withAdvisoryLock } from "./locks.js";

/** Default staleness cutoff (~Lambda max timeout): older RUNNING runs must be dead. */
export const DEFAULT_STALE_RUN_MS = 15 * 60 * 1000;

/**
 * Relabel `sync_run` rows stuck in RUNNING past the staleness threshold to ABANDONED.
 * These are runs whose process died (Lambda timeout/OOM/kill) before writing a terminal
 * status. It touches no watermark or data; the next scheduled run already self-heals via
 * the watermark. Run at handler startup so a dead run never masquerades as in-flight.
 * Each reaped data run also pushes a failure beat, the only way the watchdog can see a
 * killed process, because that process could not report its own end.
 */
export async function reapStaleRuns(
  prisma: PrismaClient,
  heartbeat?: HeartbeatSink,
  staleMs: number = DEFAULT_STALE_RUN_MS,
): Promise<number> {
  const cutoff = new Date(Date.now() - staleMs);
  const error = "reaped: still RUNNING past the staleness threshold (process likely timed out or was killed)";
  const reaped = await prisma.syncRun.updateManyAndReturn({
    where: { status: SyncStatus.RUNNING, startedAt: { lt: cutoff } },
    data: { status: SyncStatus.ABANDONED, finishedAt: new Date(), error },
    select: { storeId: true, kind: true, startedAt: true },
  });
  if (reaped.length > 0) logger.warn("reaped stale sync runs", { count: reaped.length, staleMs });
  if (heartbeat) {
    const dataRuns = reaped.filter((run) => run.kind !== SyncKind.ADMIN);
    dataRuns.sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
    for (const run of dataRuns) await pushAbandonedBeat(heartbeat, run, error);
  }
  return reaped.length;
}

/**
 * Report a reaped run as failed at its start time: a later success then already covers it,
 * so reaping a long-dead run can't raise ERRORING. The store's run lock being held means a
 * process is still working, possibly this very row (a run may outlive the staleness
 * threshold), so no beat goes out and that run reports its own outcome.
 */
async function pushAbandonedBeat(
  sink: HeartbeatSink,
  run: { storeId: string; kind: SyncKind; startedAt: Date },
  error: string,
): Promise<void> {
  const { storeId, kind, startedAt: finishedAt } = run;
  try {
    await withAdvisoryLock(`sync_run:${storeId}`, () =>
      pushHeartbeat(sink, { storeId, kind, status: SyncStatus.ABANDONED, finishedAt, error }),
    );
  } catch (err) {
    if (err instanceof ConcurrentRunError) logger.info("skipped reaped-run heartbeat: store has a live run", { storeId });
    else logger.warn("failed to push reaped-run heartbeat (non-fatal)", { storeId, kind, err });
  }
}

/** The terminal outcome of a data run, handed to a {@link HeartbeatSink}. */
export interface RunHeartbeat {
  storeId: string;
  kind: SyncKind;
  /** A terminal status — COMPLETED, FAILED or ABANDONED. */
  status: SyncStatus;
  finishedAt: Date;
  error: string | null;
}

/**
 * A best-effort push of a run's terminal outcome to the dedicated monitoring DB (the
 * watchdog reads these instead of holding this DB's credentials). Injected
 * so s-ingest-core stays decoupled from @checkin/monitoring-db; the service wiring binds
 * it to a concrete sink. It MUST NOT throw in a way that fails the run — withSyncRun calls
 * it inside a swallow-and-log guard.
 */
export type HeartbeatSink = (beat: RunHeartbeat) => void | Promise<void>;

/** Audit attribution for a run. Required in practice for operator ADMIN runs. */
export interface RunMeta {
  /** Who triggered the run (e.g. an IAM principal, an operator id, or "cli:<user>"). */
  actor?: string;
  /** Free-text justification — why the run was triggered. */
  reason?: string;
  /**
   * Optional freshness push. Fired best-effort on the terminal transition of a DATA run
   * (INCREMENTAL/BACKFILL) only — never for ADMIN runs, so a replay/reset can't reset the freshness clock. A failure
   * to push never fails the run (the monitoring DB is non-critical to ingestion).
   */
  heartbeat?: HeartbeatSink;
}

/**
 * A run's `fn` may attach partial progress to the error it throws so that a FAILED run still
 * records how far it got (e.g. a replay that commits row-by-row and dies mid-stream). Throw
 * `Object.assign(err, { partialCounts: {...} })`; withSyncRun writes `partialCounts` into the
 * FAILED row's `counts`. Optional — an error without it just records no counts.
 */
export interface PartialProgressError extends Error {
  partialCounts: Record<string, unknown>;
}

/** Extract a `partialCounts` bag from a thrown error, if the fn attached one. */
function partialCountsOf(err: unknown): Record<string, unknown> | null {
  if (err && typeof err === "object" && "partialCounts" in err) {
    const pc = (err as { partialCounts?: unknown }).partialCounts;
    if (pc && typeof pc === "object") return pc as Record<string, unknown>;
  }
  return null;
}

/** Push a heartbeat without ever letting a monitoring-DB failure break the run. */
async function pushHeartbeat(sink: HeartbeatSink, beat: RunHeartbeat): Promise<void> {
  try {
    await sink(beat);
  } catch (err) {
    logger.warn("failed to push run heartbeat to monitoring DB (non-fatal)", {
      storeId: beat.storeId,
      kind: beat.kind,
      status: beat.status,
      err,
    });
  }
}

export async function withSyncRun<T extends Record<string, unknown>>(
  prisma: PrismaClient,
  storeId: string,
  kind: SyncKind,
  objectScope: string,
  fn: (runId: bigint) => Promise<T>,
  meta: RunMeta = {},
): Promise<T> {
  // Serialize every run for a store behind a Postgres advisory lock so raw-log dedup,
  // watermark advance, and the bulk state machine can never interleave across two
  // invocations — correctness does not rest solely on reserved-concurrency = 1. A run that
  // can't take the lock throws ConcurrentRunError *before* any sync_run row is created, so a
  // skipped invocation leaves no FAILED row; the caller treats it as a benign skip.
  return withAdvisoryLock(`sync_run:${storeId}`, async () => {
    const run = await prisma.syncRun.create({
      data: {
        storeId,
        kind,
        objectScope,
        status: SyncStatus.RUNNING,
        actor: meta.actor ?? null,
        reason: meta.reason ?? null,
      },
      select: { id: true },
    });
    // ADMIN runs (replay / reset-watermark) deliberately never push a heartbeat, so an
    // operator action can neither reset the freshness clock nor look like a pipeline fault.
    const heartbeat = kind === SyncKind.ADMIN ? undefined : meta.heartbeat;
    try {
      const counts = await fn(run.id);
      const finishedAt = new Date();
      await prisma.syncRun.update({
        where: { id: run.id },
        data: { status: SyncStatus.COMPLETED, finishedAt, counts: counts as Prisma.InputJsonValue },
      });
      logger.info("sync run completed", {
        runId: run.id.toString(),
        kind,
        objectScope,
        actor: meta.actor ?? null,
        reason: meta.reason ?? null,
        ...counts,
      });
      if (heartbeat) {
        await pushHeartbeat(heartbeat, { storeId, kind, status: SyncStatus.COMPLETED, finishedAt, error: null });
      }
      return counts;
    } catch (err) {
      const finishedAt = new Date();
      const message = redactSecrets(err instanceof Error ? err.message : String(err));
      // If fn committed partial work before failing (e.g. a row-by-row replay), persist how far
      // it got so the FAILED run is honest about progress rather than reporting nothing.
      const partialCounts = partialCountsOf(err);
      await prisma.syncRun.update({
        where: { id: run.id },
        data: {
          status: SyncStatus.FAILED,
          finishedAt,
          error: message,
          ...(partialCounts ? { counts: partialCounts as Prisma.InputJsonValue } : {}),
        },
      });
      logger.error("sync run failed", { runId: run.id.toString(), kind, objectScope, partialCounts, err });
      if (heartbeat) {
        await pushHeartbeat(heartbeat, { storeId, kind, status: SyncStatus.FAILED, finishedAt, error: message });
      }
      throw err;
    }
  });
}
