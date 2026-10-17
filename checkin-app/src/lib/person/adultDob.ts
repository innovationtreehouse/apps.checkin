import { calculateAge, parseDateOnly } from "@/lib/time";
import { MAX_PROGRAM_AGE } from "@/lib/programAge";

/**
 * Normalize a DoB write so we never store a date of birth for someone over the
 * program-age ceiling (issue #1165 — "delete DoB for all adults").
 *
 * No age-gated program can target anyone over MAX_PROGRAM_AGE (25), so an exact
 * DoB for a 26+ person is dead weight on the most-sensitive field we hold. Strip
 * it and set isDeclaredAdult instead, so age gates, the people picker and the
 * household UI still classify them as an adult (all already honor the flag).
 *
 * Rules:
 *   - empty / null DoB       -> clear the date, leave isDeclaredAdult to the caller
 *                               (the "over 25" checkbox owns the flag in that case)
 *   - DoB implies age > 25   -> clear the date, set isDeclaredAdult = true
 *   - DoB implies age <= 25   -> keep the date, set isDeclaredAdult = false
 *                               (a real sub-26 DoB is authoritative, supersedes the flag)
 *
 * Route EVERY interactive path that persists Person.dateOfBirth through this. The
 * nightly cron + the #1165 backfill migration are the safety net for rows that
 * slip past (e.g. bulk import); this is the write-time guard so it can't creep back.
 *
 * A DoB is a calendar date, so a date string is parsed through `parseDateOnly` —
 * this is the choke-point that owns the calendar-date convention for interactive
 * writes. Callers pass a bare "yyyy-MM-dd", never a timed string.
 * See docs/conventions.md, "A day is not a moment".
 */
export function normalizeAdultDob(
  dob: Date | string | null | undefined,
): { dateOfBirth: Date | null; isDeclaredAdult?: boolean } {
  if (dob === null || dob === undefined || dob === "") return { dateOfBirth: null };
  const d = typeof dob === "string" ? parseDateOnly(dob)! : dob;
  if (calculateAge(d) > MAX_PROGRAM_AGE) return { dateOfBirth: null, isDeclaredAdult: true };
  return { dateOfBirth: d, isDeclaredAdult: false };
}
