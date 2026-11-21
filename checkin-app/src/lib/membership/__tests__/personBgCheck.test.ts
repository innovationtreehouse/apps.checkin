import { bgFreshThreshold, personBgVerdict } from "@/lib/membership/personBgCheck";

// Boundary = Sept 1 2026. 12-month recheck → fresh cutoff Sept 1 2025.
const BOUNDARY = new Date(Date.UTC(2026, 8, 1));
const THRESHOLD = bgFreshThreshold(BOUNDARY, 12);

function verdict(person: Partial<{ dateOfBirth: Date | null; isDeclaredAdult: boolean; lastBackgroundCheck: Date | null }>) {
    return personBgVerdict(
        { dateOfBirth: null, isDeclaredAdult: false, lastBackgroundCheck: null, ...person },
        BOUNDARY,
        THRESHOLD,
    );
}

describe("bgFreshThreshold", () => {
    it("subtracts recheckMonths from the boundary", () => {
        expect(bgFreshThreshold(BOUNDARY, 12).toISOString()).toBe("2025-09-01T00:00:00.000Z");
    });
});

describe("personBgVerdict age gate (inclusive boundary)", () => {
    // Turns 18 the day before the boundary → ≥18 → NEEDED.
    it("Aug 31 birthday is in scope", () => {
        expect(verdict({ dateOfBirth: new Date(Date.UTC(2008, 7, 31)) })).toBe("NEEDED");
    });
    // Turns 18 exactly on the boundary → inclusive → in scope.
    it("Sept 1 birthday (exactly 18 on the boundary) is in scope", () => {
        expect(verdict({ dateOfBirth: new Date(Date.UTC(2008, 8, 1)) })).toBe("NEEDED");
    });
    // Turns 18 the day after the boundary → 17 as of boundary → out.
    it("Sept 2 birthday is out of scope (still 17 at the boundary)", () => {
        expect(verdict({ dateOfBirth: new Date(Date.UTC(2008, 8, 2)) })).toBe("MINOR");
    });
    it("a young child is a MINOR", () => {
        expect(verdict({ dateOfBirth: new Date(Date.UTC(2015, 0, 1)) })).toBe("MINOR");
    });
});

describe("personBgVerdict adult/freshness/data-hygiene", () => {
    it("isDeclaredAdult with no DOB is in scope (≥18)", () => {
        expect(verdict({ isDeclaredAdult: true })).toBe("NEEDED");
    });
    it("missing DOB and not declared adult → DOB_MISSING, never cleared or needed", () => {
        expect(verdict({})).toBe("DOB_MISSING");
    });
    it("adult with a check newer than the cutoff is FRESH", () => {
        expect(verdict({ isDeclaredAdult: true, lastBackgroundCheck: new Date(Date.UTC(2025, 9, 1)) })).toBe("FRESH");
    });
    it("adult with a check older than the cutoff is NEEDED", () => {
        expect(verdict({ isDeclaredAdult: true, lastBackgroundCheck: new Date(Date.UTC(2025, 7, 1)) })).toBe("NEEDED");
    });
    it("a fresh check does not rescue a MINOR (age gate wins)", () => {
        expect(verdict({ dateOfBirth: new Date(Date.UTC(2015, 0, 1)), lastBackgroundCheck: new Date(Date.UTC(2026, 0, 1)) })).toBe("MINOR");
    });
});

describe("as-of date drives the verdict (boundary vs activation)", () => {
    // Turns 18 on Nov 1 2026: a 17-year-old as of the Sept-1-2026 boundary, an adult
    // as of a Nov 20 activation. Same person, opposite verdict, decided by the as-of date.
    const turns18Nov1 = { dateOfBirth: new Date(Date.UTC(2008, 10, 1)), isDeclaredAdult: false, lastBackgroundCheck: null };
    it("MINOR as of the membership-year boundary", () => {
        const boundary = new Date(Date.UTC(2026, 8, 1));
        expect(personBgVerdict(turns18Nov1, boundary, bgFreshThreshold(boundary, 12))).toBe("MINOR");
    });
    it("NEEDED as of a later activation date", () => {
        const activation = new Date(Date.UTC(2026, 10, 20));
        expect(personBgVerdict(turns18Nov1, activation, bgFreshThreshold(activation, 12))).toBe("NEEDED");
    });
});
