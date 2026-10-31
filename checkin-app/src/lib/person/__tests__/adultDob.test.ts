import { normalizeAdultDob } from "@/lib/person/adultDob";

// No DoB above the program-age ceiling (25). The boundary is the whole point.
describe("normalizeAdultDob", () => {
  const yearsAgo = (n: number) => {
    const d = new Date();
    d.setFullYear(d.getFullYear() - n);
    // step off the birthday so age math is unambiguous mid-year
    d.setDate(d.getDate() - 1);
    return d;
  };

  // toStrictEqual, because an absent key is what leaves the stored field alone.
  describe.each([
    { over25: undefined, flag: {} },
    { over25: true, flag: { isDeclaredAdult: true } },
    { over25: false, flag: { isDeclaredAdult: false } },
  ])("over25 $over25", ({ over25, flag }) => {
    it("writes only the declaration when no date was submitted", () => {
      expect(normalizeAdultDob(undefined, over25)).toStrictEqual(flag);
    });

    it.each([null, ""])("clears the date and writes the declaration for dob %j", (dob) => {
      expect(normalizeAdultDob(dob, over25)).toStrictEqual({ dateOfBirth: null, ...flag });
    });

    it("lets a date under the ceiling supersede the declaration", () => {
      const dob = yearsAgo(14);
      expect(normalizeAdultDob(dob, over25)).toStrictEqual({ dateOfBirth: dob, isDeclaredAdult: false });
    });

    it("strips a date over the ceiling and declares adult regardless", () => {
      expect(normalizeAdultDob(yearsAgo(26), over25)).toStrictEqual({ dateOfBirth: null, isDeclaredAdult: true });
    });
  });

  it("keeps a declaration when a form with no over-25 box saves a blank date", () => {
    expect(normalizeAdultDob(null)).not.toHaveProperty("isDeclaredAdult");
  });

  it("writes nothing when neither field was submitted", () => {
    expect(normalizeAdultDob(undefined)).toStrictEqual({});
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

  describe("a declaration with no submitted date", () => {
    it("is displaced by a date on file", () => {
      expect(normalizeAdultDob(undefined, true, yearsAgo(14))).toEqual({ isDeclaredAdult: false });
    });

    it("sets the flag when no date is on file", () => {
      expect(normalizeAdultDob(undefined, true, null)).toEqual({ isDeclaredAdult: true });
    });

    it("yields to an explicit blank date", () => {
      expect(normalizeAdultDob("", true, yearsAgo(14))).toEqual({ dateOfBirth: null, isDeclaredAdult: true });
    });
  });
});
