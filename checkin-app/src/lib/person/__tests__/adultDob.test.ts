import { normalizeAdultDob } from "@/lib/person/adultDob";

// #1165: no DoB above the program-age ceiling (25). The boundary is the whole point.
describe("normalizeAdultDob", () => {
  const yearsAgo = (n: number) => {
    const d = new Date();
    d.setFullYear(d.getFullYear() - n);
    // step off the birthday so age math is unambiguous mid-year
    d.setDate(d.getDate() - 1);
    return d;
  };

  it("clears the date and leaves the flag alone for empty input", () => {
    expect(normalizeAdultDob(null)).toEqual({ dateOfBirth: null });
    expect(normalizeAdultDob(undefined)).toEqual({ dateOfBirth: null });
    expect(normalizeAdultDob("")).toEqual({ dateOfBirth: null });
  });

  it("keeps a real DoB and un-declares for age <= 25", () => {
    const dob = yearsAgo(25);
    expect(normalizeAdultDob(dob)).toEqual({ dateOfBirth: dob, isDeclaredAdult: false });
    const teen = yearsAgo(14);
    expect(normalizeAdultDob(teen)).toEqual({ dateOfBirth: teen, isDeclaredAdult: false });
  });

  it("strips the DoB and declares adult for age > 25", () => {
    expect(normalizeAdultDob(yearsAgo(26))).toEqual({ dateOfBirth: null, isDeclaredAdult: true });
    expect(normalizeAdultDob(yearsAgo(40))).toEqual({ dateOfBirth: null, isDeclaredAdult: true });
  });

  // F1: this is the choke-point that owns the calendar-date storage convention
  // for interactive DoB writes. One convention, or the same person's stored DoB
  // shifts by a calendar day depending on which form last touched it — and a
  // non-midnight DoB silently fails SQL age filters cut at UTC midnight (#1447).
  it("stores a date-only string at UTC midnight", () => {
    const teenBirthYear = new Date().getUTCFullYear() - 14;
    expect(normalizeAdultDob(`${teenBirthYear}-05-04`).dateOfBirth!.toISOString())
      .toBe(`${teenBirthYear}-05-04T00:00:00.000Z`);
  });

  // The 26th-birthday boundary decides a persisted DoB strip, so a UTC-midnight
  // DoB read through local calendar fields would destroy the date a day early.
  describe("26th-birthday boundary west of UTC", () => {
    const realTz = process.env.TZ;
    const DOB = "2000-07-24T00:00:00.000Z";
    beforeAll(() => {
      process.env.TZ = "America/Chicago";
      jest.useFakeTimers();
    });
    afterAll(() => {
      jest.useRealTimers();
      if (realTz === undefined) delete process.env.TZ; else process.env.TZ = realTz;
    });

    it("keeps the DoB at noon on the day before the 26th birthday", () => {
      jest.setSystemTime(new Date("2026-07-23T17:00:00.000Z"));
      expect(normalizeAdultDob(DOB)).toEqual({ dateOfBirth: new Date(DOB), isDeclaredAdult: false });
    });

    it("strips the DoB on the 26th birthday", () => {
      jest.setSystemTime(new Date("2026-07-24T17:00:00.000Z"));
      expect(normalizeAdultDob(DOB)).toEqual({ dateOfBirth: null, isDeclaredAdult: true });
    });
  });
});
