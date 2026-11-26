import { checkProgramAge, hasKnownAge, isKnownAdult, isLeaderAgeEligible, leaderAgeCutoff, LEADER_MIN_AGE, validateProgramAgeBounds, MAX_PROGRAM_AGE } from "@/lib/programAge";
import { calendarDayIn } from "@/lib/time";

// as-of date pins calculateAge so the DOB cases don't drift with wall-clock time.
const asOf = "2026-01-01";
const today = new Date("2026-10-12T00:00:00.000Z");
// 12:30 AM on the 12th in New York, 11:30 PM on the 11th in Chicago.
const instant = "2026-10-12T04:30:00.000Z";
const newYork = calendarDayIn(instant, "America/New_York");
const chicago = calendarDayIn(instant, "America/Chicago");

describe("checkProgramAge", () => {
  it("passes anyone when the program has no age bounds", () => {
    expect(checkProgramAge({ dateOfBirth: null }, { minAge: null, maxAge: null, asOf }).ok).toBe(true);
  });

  it("lets a declared over-25 adult into a '16 and up' program without a DOB", () => {
    expect(
      checkProgramAge({ dateOfBirth: null, isDeclaredAdult: true }, { minAge: 16, maxAge: null, asOf }).ok,
    ).toBe(true);
  });

  it("blocks a declared adult from a youth program with a maximum age", () => {
    const r = checkProgramAge({ dateOfBirth: null, isDeclaredAdult: true }, { minAge: 8, maxAge: 16, asOf });
    expect(r).toEqual({ ok: false, reason: "age", label: "Adult" });
  });

  it("blocks a declared adult when the minimum is above 25 (over-25 can't guarantee it)", () => {
    const r = checkProgramAge({ dateOfBirth: null, isDeclaredAdult: true }, { minAge: 30, maxAge: null, asOf });
    expect(r).toEqual({ ok: false, reason: "age", label: "Adult" });
  });

  it("treats a missing DOB with no adult flag as missing data", () => {
    const r = checkProgramAge({ dateOfBirth: null }, { minAge: 16, maxAge: null, asOf });
    expect(r).toEqual({ ok: false, reason: "dob", label: "DOB missing" });
  });

  it("enforces min/max against a real DOB", () => {
    expect(checkProgramAge({ dateOfBirth: "2015-01-01" }, { minAge: 16, maxAge: null, asOf })).toEqual({
      ok: false,
      reason: "age",
      label: "Too young",
    });
    expect(checkProgramAge({ dateOfBirth: "1990-01-01" }, { minAge: null, maxAge: 16, asOf })).toEqual({
      ok: false,
      reason: "age",
      label: "Too old",
    });
    expect(checkProgramAge({ dateOfBirth: "2000-01-01" }, { minAge: 16, maxAge: 40, asOf }).ok).toBe(true);
  });
});

describe("isKnownAdult", () => {
  // n years ago today, as a calendar date at UTC midnight — how a DOB is stored.
  // Built from a moment instead, the 18 case is a birthday landing at whatever
  // time the suite happens to run, and the boundary it is testing moves.
  const yearsAgo = (n: number) => {
    const d = new Date(today);
    d.setUTCFullYear(d.getUTCFullYear() - n);
    return d;
  };

  it("admits an 18+ DOB and a declared over-25 adult", () => {
    expect(isKnownAdult({ dateOfBirth: yearsAgo(18) }, today)).toBe(true);
    expect(isKnownAdult({ dateOfBirth: yearsAgo(40) }, today)).toBe(true);
    expect(isKnownAdult({ dateOfBirth: null, isDeclaredAdult: true }, today)).toBe(true);
  });

  it("refuses a under-18 DOB", () => {
    expect(isKnownAdult({ dateOfBirth: yearsAgo(17) }, today)).toBe(false);
    expect(isKnownAdult({ dateOfBirth: yearsAgo(10) }, today)).toBe(false);
  });

  it("fails closed on an unverifiable age", () => {
    expect(isKnownAdult({ dateOfBirth: null }, today)).toBe(false);
    expect(isKnownAdult({ dateOfBirth: null, isDeclaredAdult: false }, today)).toBe(false);
  });

  it("turns 18 at the org's midnight", () => {
    const dob = new Date("2008-10-12T00:00:00.000Z");
    expect(isKnownAdult({ dateOfBirth: dob }, newYork)).toBe(true);
    expect(isKnownAdult({ dateOfBirth: dob }, chicago)).toBe(false);
  });

  it("lets a real DOB outrank the declared-adult flag", () => {
    expect(isKnownAdult({ dateOfBirth: yearsAgo(15), isDeclaredAdult: true }, today)).toBe(false);
  });
});

describe("isLeaderAgeEligible", () => {
  const yearsAgo = (n: number) => {
    const d = new Date(today);
    d.setUTCFullYear(d.getUTCFullYear() - n);
    return d;
  };

  it("admits someone 23 or older", () => {
    expect(isLeaderAgeEligible({ dateOfBirth: yearsAgo(23) }, today)).toBe(true);
    expect(isLeaderAgeEligible({ dateOfBirth: yearsAgo(40) }, today)).toBe(true);
  });

  it("rejects someone under 23", () => {
    expect(isLeaderAgeEligible({ dateOfBirth: yearsAgo(22) }, today)).toBe(false);
    expect(isLeaderAgeEligible({ dateOfBirth: yearsAgo(18) }, today)).toBe(false);
  });

  it("admits isDeclaredAdult (marked 25+)", () => {
    expect(isLeaderAgeEligible({ dateOfBirth: null, isDeclaredAdult: true }, today)).toBe(true);
  });

  it("fails closed on unknown DOB without the flag", () => {
    expect(isLeaderAgeEligible({ dateOfBirth: null }, today)).toBe(false);
    expect(isLeaderAgeEligible({ dateOfBirth: null, isDeclaredAdult: false }, today)).toBe(false);
  });

  it("turns 23 at the org's midnight, agreeing with leaderAgeCutoff", () => {
    const dob = new Date("2003-10-12T00:00:00.000Z");
    expect(isLeaderAgeEligible({ dateOfBirth: dob }, newYork)).toBe(true);
    expect(isLeaderAgeEligible({ dateOfBirth: dob }, chicago)).toBe(false);
    expect(dob <= leaderAgeCutoff(newYork)).toBe(true);
    expect(dob <= leaderAgeCutoff(chicago)).toBe(false);
  });

  it("constant matches 23", () => {
    expect(LEADER_MIN_AGE).toBe(23);
  });
});

describe("hasKnownAge", () => {
  it("is true for a DOB or the over-25 declaration, false for neither", () => {
    expect(hasKnownAge({ dateOfBirth: "2015-01-01" })).toBe(true);
    expect(hasKnownAge({ dateOfBirth: null, isDeclaredAdult: true })).toBe(true);
    expect(hasKnownAge({ dateOfBirth: null, isDeclaredAdult: false })).toBe(false);
    expect(hasKnownAge({ dateOfBirth: null })).toBe(false);
  });
});

describe("validateProgramAgeBounds", () => {
  it("accepts null/undefined (optional bounds)", () => {
    expect(validateProgramAgeBounds()).toBeNull();
    expect(validateProgramAgeBounds(null, null)).toBeNull();
  });

  it("accepts a valid range within the 25 ceiling", () => {
    expect(validateProgramAgeBounds(14, 18)).toBeNull();
    expect(validateProgramAgeBounds(0, MAX_PROGRAM_AGE)).toBeNull();
  });

  it("rejects a bound that is not a whole number, such as an empty form field", () => {
    expect(validateProgramAgeBounds("", null)).toBe("minAge must be a whole number");
    expect(validateProgramAgeBounds(null, "12")).toBe("maxAge must be a whole number");
    expect(validateProgramAgeBounds(8.5, null)).toBe("minAge must be a whole number");
  });

  it("rejects ages over 25 (the 'over 25' bucket, not a real age)", () => {
    expect(validateProgramAgeBounds(26, null)).toBe("minAge cannot exceed 25");
    expect(validateProgramAgeBounds(null, 26)).toBe("maxAge cannot exceed 25");
  });

  it("rejects negatives and inverted ranges", () => {
    expect(validateProgramAgeBounds(-1, null)).toBe("minAge cannot be negative");
    expect(validateProgramAgeBounds(null, -1)).toBe("maxAge cannot be negative");
    expect(validateProgramAgeBounds(18, 14)).toBe("minAge cannot exceed maxAge");
  });
});

describe("leaderAgeCutoff", () => {
  it("is the org zone's day, LEADER_MIN_AGE years back", () => {
    expect(leaderAgeCutoff(newYork).toISOString()).toBe("2003-10-12T00:00:00.000Z");
    expect(leaderAgeCutoff(chicago).toISOString()).toBe("2003-10-11T00:00:00.000Z");
  });
});
