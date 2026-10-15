/**
 * Wrap an orchestrated run in a `sync_run` record for observability: one row that
 * captures start/finish, status, counts, and any error.
 */
import type { PrismaClient } from "../db/client.js";
import { SyncKind, SyncStatus } from "../generated/prisma/client.js";
import type { Prisma } from "../generated/prisma/client.js";
import { logger } from "../logger.js";
import { redactSecrets } from "../redact.js";
import { withAdvisoryLock } from "./locks.js";

/** Default staleness cutoff (~Lambda max timeout): older RUNNING runs must be dead. */
export const DEFAULT_STALE_RUN_MS = 15 * 60 * 1000;

/**
 * Relabel `sync_run` rows stuck in RUNNING past the staleness threshold to ABANDONED.
 * These are runs whose process died (Lambda timeout/OOM/kill) before writing a terminal
 * status. Cosmetic only — it touches no watermark or data; the next scheduled run
 * already self-heals via the watermark. Run at handler startup so a dead run never
 * masquerades as in-flight. With Lambda reserved concurrency = 1, any RUNNING row at
 * startup is guaranteed stale; the threshold keeps it correct even without that setting.
 */
export async function reapStaleRuns(prisma: PrismaClient, staleMs: number = DEFAULT_STALE_RUN_MS): Promise<number> {
  const cutoff = new Date(Date.now() - staleMs);
  const result = await prisma.syncRun.updateMany({
    where: { status: SyncStatus.RUNNING, startedAt: { lt: cutoff } },
    data: {
      status: SyncStatus.ABANDONED,
      finishedAt: new Date(),
      error: "reaped: still RUNNING past the staleness threshold (process likely timed out or was killed)",
    },
  });
  if (result.count > 0) logger.warn("reaped stale sync runs", { count: result.count, staleMs });
  return result.count;
}

/** The terminal outcome of a data run, handed to a {@link HeartbeatSink}. */
export interface RunHeartbeat {
  storeId: string;
  kind: SyncKind;
  /** A terminal status — COMPLETED or FAILED. */
  status: SyncStatus;
  finishedAt: Date;
  error: string | null;
  counts?: Record<string, unknown>;
}

/**
 * A best-effort push of a run's terminal outcome to the dedicated monitoring DB (the F7
 * push model — the watchdog reads these instead of holding this DB's credentials). Injected
 * so s-ingest-core stays decoupled from @inventory/monitoring-db; the service wiring binds
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
   * (INCREMENTAL/BACKFILL) only — never for ADMIN runs, mirroring the watchdog's historical
   * `kind <> 'ADMIN'` exclusion so a replay/reset can't reset the freshness clock. A failure
   * to push never fails the run (the monitoring DB is non-critical to ingestion).
   */
  heartbeat?: HeartbeatSink;
}

/**
 * A run's `fn` may attach partial progress to the error it throws so that a FAILED run still
 * records how far it got (e.g. a replay that commits row-by-row and dies mid-stream). Throw
 * `Object.assign(err, { partialCounts: {...} })`; withSyncRun writes `partialCounts` into the
 * FAILED row's `counts`. Optional — an error without it just records no counts, as before.
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
  // F19: serialize every run for a store behind a Postgres advisory lock so raw-log dedup,
  // watermark advance, and the bulk state machine can never interleave across two
  // invocations — correctness no longer rests solely on reserved-concurrency = 1. A run that
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
        await pushHeartbeat(heartbeat, { storeId, kind, status: SyncStatus.COMPLETED, finishedAt, error: null, counts });
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
        // Forward partialCounts (e.g. a bulk export's badLineCount) so the watchdog sees how far
        // a failed run got, not just that it failed.
        await pushHeartbeat(heartbeat, {
          storeId,
          kind,
          status: SyncStatus.FAILED,
          finishedAt,
          error: message,
          ...(partialCounts ? { counts: partialCounts } : {}),
        });
      }
      throw err;
    }
  });
}
