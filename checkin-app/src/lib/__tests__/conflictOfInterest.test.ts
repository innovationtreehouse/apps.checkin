import { sharesHousehold, hasHouseholdConflict } from "@/lib/conflictOfInterest";
import type { DbClient } from "@/lib/db-client";

describe("sharesHousehold", () => {
    it("true only when both ids are present and equal", () => {
        expect(sharesHousehold(5, 5)).toBe(true);
        expect(sharesHousehold(5, 6)).toBe(false);
    });

    it("false when either side is null/undefined (no household ≠ shared household)", () => {
        expect(sharesHousehold(null, null)).toBe(false); // two people with no household don't conflict
        expect(sharesHousehold(undefined, 5)).toBe(false);
        expect(sharesHousehold(5, null)).toBe(false);
    });
});

describe("hasHouseholdConflict", () => {
    const db = (actorHouseholdId: number | null, actorRow: Record<string, unknown> = {}) =>
        ({ person: { findUnique: jest.fn().mockResolvedValue(actorHouseholdId == null ? null : { householdId: actorHouseholdId, ...actorRow }) } }) as unknown as DbClient;

    it("conflict when the actor shares the subject's household", async () => {
        expect(await hasHouseholdConflict(db(3), 1, 3)).toBe(true);
    });

    it("no conflict when the actor is in a different household", async () => {
        expect(await hasHouseholdConflict(db(4), 1, 3)).toBe(false);
    });

    it("still conflicts when the actor holds every privileged role", async () => {
        const privileged = { isSysadmin: true, isBoardMember: true, isBackgroundCheckReviewer: true, isKeyholder: true };
        expect(await hasHouseholdConflict(db(3, privileged), 1, 3)).toBe(true);
    });

    it("no conflict when the subject has no household to conflict with", async () => {
        expect(await hasHouseholdConflict(db(3), 1, null)).toBe(false);
    });

    it.each([
        ["an actor id that resolves to nobody", 1],
        ["an actor id that is not a positive integer", 0],
    ])("conflicts (fails closed) for %s", async (_label, actorId) => {
        expect(await hasHouseholdConflict(db(null), actorId, 3)).toBe(true);
    });
});
