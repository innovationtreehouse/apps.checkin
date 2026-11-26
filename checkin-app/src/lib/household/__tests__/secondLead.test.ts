import { isAdultAsOf, isMinorAsOf, secondLeadQuestionDue } from "@/lib/household/secondLead";

/** Who the household's only lead is asked to make a second lead. */

const NOW = new Date("2026-08-02");
const yearsAgo = (n: number) => new Date(Date.UTC(2026 - n, 7, 2));

const lead = (id: number) => ({ id, isHouseholdLead: true, dateOfBirth: yearsAgo(40) });
const adult = (id: number) => ({ id, isHouseholdLead: false, dateOfBirth: yearsAgo(30) });
const declared = (id: number) => ({ id, isHouseholdLead: false, isDeclaredAdult: true });
const child = (id: number) => ({ id, isHouseholdLead: false, dateOfBirth: yearsAgo(10) });
const unknownAge = (id: number) => ({ id, isHouseholdLead: false });

describe("isAdultAsOf / isMinorAsOf", () => {
    it("reads a DOB on the given org day, and trusts the over-25 declaration without one", () => {
        expect(isAdultAsOf({ dateOfBirth: yearsAgo(18) }, NOW)).toBe(true);
        expect(isAdultAsOf({ dateOfBirth: yearsAgo(17) }, NOW)).toBe(false);
        expect(isAdultAsOf({ isDeclaredAdult: true }, NOW)).toBe(true);
        expect(isAdultAsOf({}, NOW)).toBe(false);
        // The day before the 18th birthday.
        expect(isAdultAsOf({ dateOfBirth: yearsAgo(18) }, new Date("2026-08-01"))).toBe(false);
    });

    it("treats only a DOB under 18 as a known minor", () => {
        expect(isMinorAsOf({ dateOfBirth: yearsAgo(17) }, NOW)).toBe(true);
        expect(isMinorAsOf({}, NOW)).toBe(false);
        expect(isMinorAsOf({ dateOfBirth: yearsAgo(30) }, NOW)).toBe(false);
    });
});

describe("secondLeadQuestionDue", () => {
    it("asks the only lead about any adult who isn't a lead", () => {
        expect(secondLeadQuestionDue([lead(1), adult(2)], 2, NOW)).toBe(true);
        expect(secondLeadQuestionDue([lead(1), child(3), declared(2)], 2, NOW)).toBe(true);
        expect(secondLeadQuestionDue([lead(1), adult(2), adult(5)], 5, NOW)).toBe(true);
    });

    it("never asks in a two-lead household", () => {
        expect(secondLeadQuestionDue([lead(1), lead(4), adult(2)], 2, NOW)).toBe(false);
    });

    it("never asks about a minor, a lead or an unknown age, or in a household with no lead", () => {
        expect(secondLeadQuestionDue([lead(1), child(3)], 3, NOW)).toBe(false);
        expect(secondLeadQuestionDue([lead(1)], 1, NOW)).toBe(false);
        expect(secondLeadQuestionDue([lead(1), unknownAge(3)], 3, NOW)).toBe(false);
        expect(secondLeadQuestionDue([adult(2)], 2, NOW)).toBe(false);
    });
});
