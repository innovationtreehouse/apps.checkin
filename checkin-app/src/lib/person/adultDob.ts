import { calculateAge, isYouth, parseDateOnly } from "@/lib/time";
import { hasKnownAge, MAX_PROGRAM_AGE } from "@/lib/programAge";

export const UNDER_18_DECLARATION_REFUSAL =
  "This person's date of birth on file shows they are under 18, so they can't be declared over 25. If the date is wrong, enter the correct one.";

/** Whether one request would blank a stored under-18 date and declare the person over 25. */
export function replacesUnder18Date(
  dob: Date | string | null | undefined,
  over25: boolean | undefined,
  dobOnFile: Date | null | undefined,
  today: Date,
): boolean {
  return !!over25 && (dob === null || dob === "") && isYouth(dobOnFile, today);
}

/**
 * The Person fields to write for a submitted date of birth and over-25 declaration,
 * so we never store a date of birth for someone over the program-age ceiling.
 *
 * No age-gated program can target anyone over MAX_PROGRAM_AGE (25), so an exact
 * DoB for a 26+ person is dead weight on the most-sensitive field we hold. Strip
 * it and set isDeclaredAdult instead, so age gates, the people picker and the
 * household UI still classify them as an adult (all already honor the flag).
 *
 * Rules, where `undefined` always means "not submitted, leave the field alone":
 *   - DoB implies age > 25   -> clear the date, set isDeclaredAdult = true
 *   - DoB implies age <= 25  -> keep the date, set isDeclaredAdult = false
 *                               (a real sub-26 DoB is authoritative, supersedes over25)
 *   - empty / null DoB       -> clear the date; over25, if submitted, sets the flag
 *   - undefined DoB          -> keep the date; over25, if submitted, sets the flag,
 *                               unless `dobOnFile` holds a date, which displaces it
 *
 * A form with no over-25 box omits over25, so saving someone's blank date there
 * keeps their declaration.
 *
 * Route EVERY interactive path that persists Person.dateOfBirth through this. The
 * nightly cron is the safety net for rows that slip past; this is the write-time
 * guard so they can't creep back.
 *
 * A DoB is a calendar date, so a date string is parsed through `parseDateOnly` —
 * this is the choke-point that owns the calendar-date convention for interactive
 * writes. Callers pass a bare "yyyy-MM-dd", never a timed string.
 * See docs/conventions.md, "A day is not a moment".
 */
export function normalizeAdultDob(
  dob: Date | string | null | undefined,
  today: Date,
  over25?: boolean,
  dobOnFile?: Date | null,
): { dateOfBirth?: Date | null; isDeclaredAdult?: boolean } {
  const declaration = over25 === undefined ? {} : { isDeclaredAdult: !!over25 };
  if (dob === undefined) return over25 && dobOnFile ? { isDeclaredAdult: false } : declaration;
  if (dob === null || dob === "") return { dateOfBirth: null, ...declaration };
  const d = typeof dob === "string" ? parseDateOnly(dob)! : dob;
  if (calculateAge(d, today) > MAX_PROGRAM_AGE) return { dateOfBirth: null, isDeclaredAdult: true };
  return { dateOfBirth: d, isDeclaredAdult: false };
}

export const AGE_LEAD_ONLY_REFUSAL =
  "Only a household lead can set or change a date of birth or over-25 declaration in this household.";

/** Once a household has a lead, only a lead sets its members' ages, their own included. */
export function mayDeclareAges(callerId: number, leadIds: readonly number[]): boolean {
  return leadIds.length === 0 || leadIds.includes(callerId);
}

/** Whether writing `age` (from {@link normalizeAdultDob}) changes what is on file; a new person has nothing on file. */
export function changesAge(
  age: { dateOfBirth?: Date | null; isDeclaredAdult?: boolean },
  onFile?: { dateOfBirth: Date | null; isDeclaredAdult: boolean | null } | null,
): boolean {
  const dobChanged = age.dateOfBirth !== undefined
    && (age.dateOfBirth?.getTime() ?? null) !== (onFile?.dateOfBirth?.getTime() ?? null);
  const declarationChanged = age.isDeclaredAdult !== undefined && age.isDeclaredAdult !== !!onFile?.isDeclaredAdult;
  return dobChanged || declarationChanged;
}

export const AGE_REQUIRED_REFUSAL =
  "Enter a date of birth, or tick \"over 25\" for an adult. Everyone needs an age on file.";

/** Whether writing `age` (from {@link normalizeAdultDob}) leaves the person with no age on file. */
export function leavesAgeUnknown(
  age: { dateOfBirth?: Date | null; isDeclaredAdult?: boolean },
  onFile?: { dateOfBirth: Date | null; isDeclaredAdult: boolean | null } | null,
): boolean {
  const dateOfBirth = age.dateOfBirth !== undefined ? age.dateOfBirth : (onFile?.dateOfBirth ?? null);
  const isDeclaredAdult = age.isDeclaredAdult ?? !!onFile?.isDeclaredAdult;
  return !hasKnownAge({ dateOfBirth, isDeclaredAdult });
}
