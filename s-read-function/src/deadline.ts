/** The sync run's hard lifetime in minutes: SYNC_DEADLINE_MINUTES, default 55, at least 1. */
export function syncDeadlineMinutes(): number {
  return Math.max(1, Number(process.env.SYNC_DEADLINE_MINUTES) || 55);
}
