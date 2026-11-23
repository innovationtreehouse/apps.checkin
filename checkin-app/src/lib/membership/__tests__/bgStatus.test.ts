import { bgStatus } from "@/lib/membership/bgStatus";

// Boundary 1 Sept, 12-month recheck interval.
const settings = { orgMembershipYearBoundary: new Date(Date.UTC(2000, 8, 1)), bgRecheckMonths: 12 };
const day = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));
// Mid-year: the upcoming boundary is 1 Sept 2026, so a check counts there from 1 Sept 2025.
const MARCH = new Date(Date.UTC(2026, 2, 15, 18));

describe("bgStatus", () => {
    it("is VALID from the upcoming boundary's threshold on", () => {
        expect(bgStatus(day(2025, 9, 1), settings, MARCH)).toBe("VALID");
        expect(bgStatus(day(2026, 1, 1), settings, MARCH)).toBe("VALID");
    });

    it("expires before the upcoming year just under the threshold", () => {
        expect(bgStatus(new Date(day(2025, 9, 1).getTime() - 1), settings, MARCH)).toBe("EXPIRES_BEFORE_NEXT_YEAR");
        expect(bgStatus(day(2024, 9, 2), settings, MARCH)).toBe("EXPIRES_BEFORE_NEXT_YEAR");
    });

    it("is EXPIRED once it no longer covers the boundary just passed", () => {
        expect(bgStatus(day(2024, 9, 1), settings, MARCH)).toBe("EXPIRED");
        expect(bgStatus(day(2020, 1, 1), settings, MARCH)).toBe("EXPIRED");
    });

    it("still counts on the boundary day it covers, and is EXPIRED the day after", () => {
        const check = day(2024, 8, 15);
        expect(bgStatus(check, settings, new Date(Date.UTC(2025, 8, 1, 18)))).toBe("EXPIRES_BEFORE_NEXT_YEAR");
        expect(bgStatus(check, settings, new Date(Date.UTC(2025, 8, 2, 18)))).toBe("EXPIRED");
    });

    it("shows nothing with the interval or boundary unset, or no check on file", () => {
        expect(bgStatus(day(2026, 1, 1), { ...settings, bgRecheckMonths: 0 }, MARCH)).toBeNull();
        expect(bgStatus(day(2026, 1, 1), { ...settings, orgMembershipYearBoundary: null }, MARCH)).toBeNull();
        expect(bgStatus(null, settings, MARCH)).toBeNull();
    });
});
