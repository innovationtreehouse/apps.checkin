import { calculateAge, isYouth, orgCalendarDay } from "@/lib/time";

/**
 * Whether we KNOW this person is an adult: declared over 25, or 18+ by DOB.
 * Fails closed — an unknown age is not an adult — because the only caller is the
 * self-enrollment gate, where "can't prove adult" must refuse rather than admit.
 *
 * A declared adult is trusted whoever set the flag, including the member
 * themselves: docs/rules/programs.md takes an unverified self-declaration as a
 * risk knowingly accepted.
 */
export function isKnownAdult(person: { dateOfBirth: Date | string | null; isDeclaredAdult?: boolean | null }): boolean {
  // A real DOB outranks the flag, as in checkProgramAge: the flag exists to stand
  // in for a missing DOB, not to contradict one on file.
  return person.dateOfBirth ? !isYouth(person.dateOfBirth) : !!person.isDeclaredAdult;
}

/**
 * The three age states the youth rules act on, as one value so an impossible
 * pair can't be represented. `youth` and `unknown` are treated OPPOSITELY: a
 * youth has the enrollment and payment surfaces hidden, while an unverifiable
 * age keeps them and is routed to age capture — hiding from the latter would
 * strand a brand-new adult who has no other household lead.
 */
export type AgeBand = "adult" | "youth" | "unknown";

export function ageBand(person: { dateOfBirth: Date | string | null; isDeclaredAdult?: boolean | null }): AgeBand {
  if (isKnownAdult(person)) return "adult";
  return person.dateOfBirth ? "youth" : "unknown";
}

/**
 * Single source of truth for "can this person enroll in this age-gated program".
 * Shared by the client member-select (enrollBlock) and the server enroll route
 * so a declared adult ("I am over 25") is treated the same in both places.
 *
 * A declared adult has no DOB on file but is known to be over 25. That's enough
 * to satisfy a youth minimum (e.g. "16 and up") and there's no youth maximum
 * they'd fall under — so they're eligible unless the program sets a finite
 * maxAge (a youth cap an over-25 adult can't be inside) or a minimum above 25
 * (which "over 25" alone can't guarantee).
 */

export type AgeReason = "dob" | "age";

export type ProgramAgeResult =
  | { ok: true }
  | { ok: false; reason: AgeReason; label: "DOB missing" | "Too young" | "Too old" | "Adult" };

export function checkProgramAge(
  person: { dateOfBirth: Date | string | null; isDeclaredAdult?: boolean },
  program: { minAge: number | null; maxAge: number | null; asOf?: Date | string },
): ProgramAgeResult {
  const { minAge, maxAge } = program;
  if (minAge === null && maxAge === null) return { ok: true };

  if (!person.dateOfBirth) {
    if (person.isDeclaredAdult) {
      const minOk = minAge === null || minAge <= 25;
      const maxOk = maxAge === null;
      return minOk && maxOk ? { ok: true } : { ok: false, reason: "age", label: "Adult" };
    }
    return { ok: false, reason: "dob", label: "DOB missing" };
  }

  const age = calculateAge(person.dateOfBirth, program.asOf);
  if (minAge !== null && age < minAge) return { ok: false, reason: "age", label: "Too young" };
  if (maxAge !== null && age > maxAge) return { ok: false, reason: "age", label: "Too old" };
  return { ok: true };
}

// Policy: Sponsored Program Policy, Art. IV — a program leader is at least 23.
export const LEADER_MIN_AGE = 23;

/**
 * Whether this person is eligible to be a program leader by age. Fails closed:
 * unknown DOB without isDeclaredAdult is not old enough.
 */
export function isLeaderAgeEligible(person: { dateOfBirth: Date | string | null; isDeclaredAdult?: boolean | null }): boolean {
  if (person.dateOfBirth) return calculateAge(person.dateOfBirth) >= LEADER_MIN_AGE;
  return !!person.isDeclaredAdult;
}

/**
 * DB-level date threshold for the leader-picker query: born on or before this
 * date ⇒ 23 or older today. The isDeclaredAdult OR leg covers null-DOB adults
 * (flag means "marked 25+" which clears 23).
 */
export function leaderAgeCutoff(): Date {
  const d = new Date(orgCalendarDay());
  d.setUTCFullYear(d.getUTCFullYear() - LEADER_MIN_AGE);
  return d;
}

/**
 * Highest age a program may target. Anyone older falls into the "over 25"
 * bucket (a single radio, no exact age recorded — see Person.isDeclaredAdult),
 * so 26+ is not a real age to gate on. minAge/maxAge must stay <= this. This is
 * exactly why a declared adult clears any youth minimum in checkProgramAge.
 */
export const MAX_PROGRAM_AGE = 25;

/**
 * Validate a program's age bounds. Returns an error message for the caller to
 * pass to apiError(400), or null when valid. Shared by every write path
 * (create, PATCH, settings) so the 25+ ceiling can't be bypassed via one route.
 */
export function validateProgramAgeBounds(minAge?: number | null, maxAge?: number | null): string | null {
  if (minAge != null && minAge < 0) return "minAge cannot be negative";
  if (maxAge != null && maxAge < 0) return "maxAge cannot be negative";
  if (minAge != null && minAge > MAX_PROGRAM_AGE) return `minAge cannot exceed ${MAX_PROGRAM_AGE}`;
  if (maxAge != null && maxAge > MAX_PROGRAM_AGE) return `maxAge cannot exceed ${MAX_PROGRAM_AGE}`;
  if (minAge != null && maxAge != null && minAge > maxAge) return "minAge cannot exceed maxAge";
  return null;
}
