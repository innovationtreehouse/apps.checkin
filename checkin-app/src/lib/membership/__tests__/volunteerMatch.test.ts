import { matchesVolunteerDesignation } from "@/lib/membership/review";

/**
 * Volunteer-designation match drives Membership.isVolunteerFamily, which drives the membership fee.
 * These lock canonicalizeEmail's Gmail rules: a +tag is dropped, and dots are
 * ignored only on Gmail.
 */
describe("matchesVolunteerDesignation", () => {
    it("matches a Gmail +tag parent against the un-tagged designation (was MISSED before)", () => {
        expect(matchesVolunteerDesignation(["foo+vol@gmail.com"], ["foo@gmail.com"])).toBe(true);
    });

    it("does NOT match distinct non-Gmail addresses that differ only by dots (was OVER-matched before)", () => {
        expect(matchesVolunteerDesignation(["foo.bar@outlook.com"], ["foobar@outlook.com"])).toBe(false);
    });

    it("still matches Gmail dot-variants and googlemail", () => {
        expect(matchesVolunteerDesignation(["Foo.Bar@GoogleMail.com"], ["foobar@gmail.com"])).toBe(true);
    });

    it("no match when no parent emails", () => {
        expect(matchesVolunteerDesignation([], ["foo@gmail.com"])).toBe(false);
    });

    it("plain non-matching addresses stay unmatched", () => {
        expect(matchesVolunteerDesignation(["parent@example.com"], ["someone@else.com"])).toBe(false);
    });
});
