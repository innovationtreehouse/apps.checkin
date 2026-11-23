import { syncDeadlineMs } from "@checkin/s-ingest-core/deadline";

/** The sync run's hard lifetime in minutes, from the same deadline the stale-run reaper reads. */
export function syncDeadlineMinutes(): number {
  return syncDeadlineMs() / 60_000;
}
