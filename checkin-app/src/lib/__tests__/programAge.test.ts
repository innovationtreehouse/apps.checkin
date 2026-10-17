import { checkProgramAge, isKnownAdult, isLeaderAgeEligible, LEADER_MIN_AGE, validateProgramAgeBounds, MAX_PROGRAM_AGE } from "@/lib/programAge";
import { orgCalendarDay } from "@/lib/time";

// as-of date pins calculateAge so the DOB cases don't drift with wall-clock time.
const asOf = "2026-01-01";

describe("checkProgramAge", () => {
  it("passes anyone when the program has no age bounds", () => {
    expect(checkProgramAge({ dateOfBirth: null }, { minAge: null, maxAge: null }).ok).toBe(true);
  });

  it("lets a declared over-25 adult into a '16 and up' program without a DOB", () => {
    expect(
      checkProgramAge({ dateOfBirth: null, isDeclaredAdult: true }, { minAge: 16, maxAge: null }).ok,
    ).toBe(true);
  });

  it("blocks a declared adult from a youth program with a maximum age", () => {
    const r = checkProgramAge({ dateOfBirth: null, isDeclaredAdult: true }, { minAge: 8, maxAge: 16 });
    expect(r).toEqual({ ok: false, reason: "age", label: "Adult" });
  });

  it("blocks a declared adult when the minimum is above 25 (over-25 can't guarantee it)", () => {
    const r = checkProgramAge({ dateOfBirth: null, isDeclaredAdult: true }, { minAge: 30, maxAge: null });
    expect(r).toEqual({ ok: false, reason: "age", label: "Adult" });
  });

  it("treats a missing DOB with no adult flag as missing data", () => {
    const r = checkProgramAge({ dateOfBirth: null }, { minAge: 16, maxAge: null });
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
    const d = orgCalendarDay();
    d.setUTCFullYear(d.getUTCFullYear() - n);
    return d;
  };

  it("admits an 18+ DOB and a declared over-25 adult", () => {
    expect(isKnownAdult({ dateOfBirth: yearsAgo(18) })).toBe(true);
    expect(isKnownAdult({ dateOfBirth: yearsAgo(40) })).toBe(true);
    expect(isKnownAdult({ dateOfBirth: null, isDeclaredAdult: true })).toBe(true);
  });

  it("refuses a under-18 DOB", () => {
    expect(isKnownAdult({ dateOfBirth: yearsAgo(17) })).toBe(false);
    expect(isKnownAdult({ dateOfBirth: yearsAgo(10) })).toBe(false);
  });

  it("fails closed on an unverifiable age", () => {
    expect(isKnownAdult({ dateOfBirth: null })).toBe(false);
    expect(isKnownAdult({ dateOfBirth: null, isDeclaredAdult: false })).toBe(false);
  });

  it("lets a real DOB outrank the declared-adult flag", () => {
    expect(isKnownAdult({ dateOfBirth: yearsAgo(15), isDeclaredAdult: true })).toBe(false);
  });
});

describe("isLeaderAgeEligible", () => {
  const yearsAgo = (n: number) => {
    const d = orgCalendarDay();
    d.setUTCFullYear(d.getUTCFullYear() - n);
    return d;
  };

  it("admits someone 23 or older", () => {
    expect(isLeaderAgeEligible({ dateOfBirth: yearsAgo(23) })).toBe(true);
    expect(isLeaderAgeEligible({ dateOfBirth: yearsAgo(40) })).toBe(true);
  });

  it("rejects someone under 23", () => {
    expect(isLeaderAgeEligible({ dateOfBirth: yearsAgo(22) })).toBe(false);
    expect(isLeaderAgeEligible({ dateOfBirth: yearsAgo(18) })).toBe(false);
  });

  it("admits isDeclaredAdult (marked 25+)", () => {
    expect(isLeaderAgeEligible({ dateOfBirth: null, isDeclaredAdult: true })).toBe(true);
  });

  it("fails closed on unknown DOB without the flag", () => {
    expect(isLeaderAgeEligible({ dateOfBirth: null })).toBe(false);
    expect(isLeaderAgeEligible({ dateOfBirth: null, isDeclaredAdult: false })).toBe(false);
  });

  it("constant matches 23", () => {
    expect(LEADER_MIN_AGE).toBe(23);
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
