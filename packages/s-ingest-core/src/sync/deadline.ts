/**
 * How long one sync run may live. The service force-exits a run at this deadline, and the
 * stale-run reaper abandons a RUNNING row only once it is past the deadline, so both read it here.
 */

/** A run's lifetime in minutes when SYNC_DEADLINE_MINUTES is unset. */
export const DEFAULT_SYNC_DEADLINE_MINUTES = 55;

/** How long past the deadline a RUNNING row waits before the reaper abandons it. */
export const REAP_MARGIN_MS = 5 * 60 * 1000;

/** A run's lifetime in ms: SYNC_DEADLINE_MINUTES (at least 1), or the default. */
export function syncDeadlineMs(): number {
  return Math.max(1, Number(process.env.SYNC_DEADLINE_MINUTES) || DEFAULT_SYNC_DEADLINE_MINUTES) * 60 * 1000;
}

/** How long a run may stay RUNNING before the reaper relabels it ABANDONED. */
export function staleRunMs(): number {
  return syncDeadlineMs() + REAP_MARGIN_MS;
}
