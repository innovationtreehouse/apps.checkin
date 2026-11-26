import { changesAge, mayDeclareAges, normalizeAdultDob } from "@/lib/person/adultDob";
import { APP_TIMEZONE, calendarDayIn } from "@/lib/time";

const today = calendarDayIn(new Date(), APP_TIMEZONE);

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
      expect(normalizeAdultDob(undefined, today, over25)).toStrictEqual(flag);
    });

    it.each([null, ""])("clears the date and writes the declaration for dob %j", (dob) => {
      expect(normalizeAdultDob(dob, today, over25)).toStrictEqual({ dateOfBirth: null, ...flag });
    });

    it("lets a date under the ceiling supersede the declaration", () => {
      const dob = yearsAgo(14);
      expect(normalizeAdultDob(dob, today, over25)).toStrictEqual({ dateOfBirth: dob, isDeclaredAdult: false });
    });

    it("strips a date over the ceiling and declares adult regardless", () => {
      expect(normalizeAdultDob(yearsAgo(26), today, over25)).toStrictEqual({ dateOfBirth: null, isDeclaredAdult: true });
    });
  });

  it("keeps a declaration when a form with no over-25 box saves a blank date", () => {
    expect(normalizeAdultDob(null, today)).not.toHaveProperty("isDeclaredAdult");
  });

  it("writes nothing when neither field was submitted", () => {
    expect(normalizeAdultDob(undefined, today)).toStrictEqual({});
  });

  it("keeps a real DoB and un-declares for age <= 25", () => {
    const dob = yearsAgo(25);
    expect(normalizeAdultDob(dob, today)).toEqual({ dateOfBirth: dob, isDeclaredAdult: false });
    const teen = yearsAgo(14);
    expect(normalizeAdultDob(teen, today)).toEqual({ dateOfBirth: teen, isDeclaredAdult: false });
  });

  it("strips the DoB and declares adult for age > 25", () => {
    expect(normalizeAdultDob(yearsAgo(26), today)).toEqual({ dateOfBirth: null, isDeclaredAdult: true });
    expect(normalizeAdultDob(yearsAgo(40), today)).toEqual({ dateOfBirth: null, isDeclaredAdult: true });
  });

  // This is the choke-point that owns the calendar-date storage convention
  // for interactive DoB writes. One convention, or the same person's stored DoB
  // shifts by a calendar day depending on which form last touched it — and a
  // non-midnight DoB silently fails SQL age filters cut at UTC midnight.
  it("stores a date-only string at UTC midnight", () => {
    const teenBirthYear = new Date().getUTCFullYear() - 14;
    expect(normalizeAdultDob(`${teenBirthYear}-05-04`, today).dateOfBirth!.toISOString())
      .toBe(`${teenBirthYear}-05-04T00:00:00.000Z`);
  });

  // The 26th-birthday boundary decides a persisted DoB strip, so a UTC-midnight
  // DoB read through local calendar fields would destroy the date a day early.
  describe("26th-birthday boundary west of UTC", () => {
    const realTz = process.env.TZ;
    const DOB = "2000-07-24T00:00:00.000Z";
    beforeAll(() => {
      process.env.TZ = "America/Chicago";
    });
    afterAll(() => {
      if (realTz === undefined) delete process.env.TZ; else process.env.TZ = realTz;
    });

    it("keeps the DoB at noon on the day before the 26th birthday", () => {
      expect(normalizeAdultDob(DOB, calendarDayIn("2026-07-23T17:00:00.000Z", "America/Chicago"))).toEqual({ dateOfBirth: new Date(DOB), isDeclaredAdult: false });
    });

    it("strips the DoB on the 26th birthday", () => {
      expect(normalizeAdultDob(DOB, calendarDayIn("2026-07-24T17:00:00.000Z", "America/Chicago"))).toEqual({ dateOfBirth: null, isDeclaredAdult: true });
    });
  });

  describe("a declaration with no submitted date", () => {
    it("is displaced by a date on file", () => {
      expect(normalizeAdultDob(undefined, today, true, yearsAgo(14))).toEqual({ isDeclaredAdult: false });
    });

    it("sets the flag when no date is on file", () => {
      expect(normalizeAdultDob(undefined, today, true, null)).toEqual({ isDeclaredAdult: true });
    });

    it("yields to an explicit blank date", () => {
      expect(normalizeAdultDob("", today, true, yearsAgo(14))).toEqual({ dateOfBirth: null, isDeclaredAdult: true });
    });
  });
});

describe("mayDeclareAges", () => {
  it("lets anyone set ages in a household with no lead", () => {
    expect(mayDeclareAges(1, [])).toBe(true);
  });
  it("lets a lead set ages, their own included", () => {
    expect(mayDeclareAges(1, [1, 2])).toBe(true);
  });
  it("refuses a non-lead once the household has a lead", () => {
    expect(mayDeclareAges(3, [1])).toBe(false);
  });
});

describe("changesAge", () => {
  const dob = new Date("2012-05-01");
  const onFile = { dateOfBirth: dob, isDeclaredAdult: false };

  it("sees no change in the same date resubmitted", () => {
    expect(changesAge(normalizeAdultDob("2012-05-01", today, false, dob), onFile)).toBe(false);
  });
  it("sees no change when nothing is submitted", () => {
    expect(changesAge(normalizeAdultDob(undefined, today), onFile)).toBe(false);
  });
  it("sees a new date", () => {
    expect(changesAge(normalizeAdultDob("2010-05-01", today, false, dob), onFile)).toBe(true);
  });
  it("sees a blanked date", () => {
    expect(changesAge(normalizeAdultDob("", today, false, dob), onFile)).toBe(true);
  });
  it("sees a new over-25 declaration", () => {
    expect(changesAge(normalizeAdultDob("", today, true), { dateOfBirth: null, isDeclaredAdult: false })).toBe(true);
  });
  it("sees no change in a declaration resubmitted", () => {
    expect(changesAge(normalizeAdultDob("", today, true), { dateOfBirth: null, isDeclaredAdult: true })).toBe(false);
  });
  it("treats any age on a new person as a change, and none as no change", () => {
    expect(changesAge(normalizeAdultDob("2012-05-01", today), null)).toBe(true);
    expect(changesAge(normalizeAdultDob("", today), null)).toBe(false);
  });
});
