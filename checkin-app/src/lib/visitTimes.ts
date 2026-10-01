export type VisitTimeResult = { ok: true; value: Date } | { ok: false; error: string };

/**
 * Parse a provided visit-time string (ISO / datetime-local). Rejects an invalid
 * date and a future time. `now` is injected so callers share one clock and tests
 * are deterministic. `field` selects the message wording.
 * Reject-not-clamp: unlike the manual self-entry endpoint there is NO 5-minute skew
 * and NO clamp — a future time on an edit is always a typo, so reject outright.
 */
export function parseVisitTime(
  input: string,
  field: "arrival" | "departure",
  now: Date,
): VisitTimeResult {
  const d = new Date(input);
  if (isNaN(d.getTime())) {
    return { ok: false, error: `Invalid ${field} time` };
  }
  if (d.getTime() > now.getTime()) {
    const Cap = field === "arrival" ? "Arrival" : "Departure";
    return { ok: false, error: `${Cap} time cannot be in the future.` };
  }
  return { ok: true, value: d };
}

/** M6: a departure must be strictly after its arrival (rejects zero-length too). */
export function departureAfterArrival(arrived: Date, departed: Date): boolean {
  return departed.getTime() > arrived.getTime();
}

/** A single visit can't span more than a day — a longer window is a missed
 * checkout or a typo, not a real visit. Applies only to closed visits. */
export const MAX_VISIT_MS = 24 * 60 * 60 * 1000;

export function withinMaxDuration(arrived: Date, departed: Date): boolean {
  return departed.getTime() - arrived.getTime() <= MAX_VISIT_MS;
}

/** Edit forms use minute-precision datetime-local inputs, so a submitted time
 * inside the stored time's minute is the untouched field echoed back, not an edit. */
export function isUnchangedTime(submitted: Date, stored: Date | null): boolean {
  return stored !== null && Math.floor(submitted.getTime() / 60000) === Math.floor(stored.getTime() / 60000);
}
