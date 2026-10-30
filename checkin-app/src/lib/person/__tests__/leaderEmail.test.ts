/**
 * @jest-environment node
 *
 * Board ruling B15, 2026-10-27: a participant's own email is hidden from
 * program leaders while the participant is under 13.
 */
import { leaderMaySeeEmail, rosterHousehold, rosterPerson, withholdEmail } from "@/lib/person/leaderEmail";

beforeAll(() => {
    jest.useFakeTimers({ now: new Date("2026-10-27T17:00:00Z"), doNotFake: ["nextTick", "setImmediate", "setTimeout", "setInterval", "queueMicrotask"] });
});
afterAll(() => jest.useRealTimers());

const TURNS_13_TODAY = new Date("2013-10-27T00:00:00Z");
const TURNS_13_TOMORROW = new Date("2013-10-28T00:00:00Z");
const person = (dateOfBirth: Date | null) => ({ id: 1, name: "Kid", email: "kid@example.com", dateOfBirth });

describe("leaderMaySeeEmail", () => {
    it("hides under 13", () => expect(leaderMaySeeEmail(TURNS_13_TOMORROW)).toBe(false));
    it("shows on the 13th birthday", () => expect(leaderMaySeeEmail(TURNS_13_TODAY)).toBe(true));
    it("hides an unknown date of birth", () => expect(leaderMaySeeEmail(null)).toBe(false));
});

describe("rosterPerson", () => {
    it("nulls the email of an under-13 participant for a leader", () => {
        expect(rosterPerson(person(TURNS_13_TOMORROW), true)).toEqual({ id: 1, name: "Kid", email: null });
    });
    it("keeps the email of a 13-year-old for a leader", () => {
        expect(rosterPerson(person(TURNS_13_TODAY), true)).toEqual({ id: 1, name: "Kid", email: "kid@example.com" });
    });
    it("nulls the email when the date of birth is unknown", () => {
        expect(rosterPerson(person(null), true)).toEqual({ id: 1, name: "Kid", email: null });
    });
    it("leaves the email alone for a viewer who is not a leader, and never ships the date of birth", () => {
        expect(rosterPerson(person(TURNS_13_TOMORROW), false)).toEqual({ id: 1, name: "Kid", email: "kid@example.com" });
        expect(rosterPerson(person(null), false)).not.toHaveProperty("dateOfBirth");
    });
});

describe("rosterHousehold", () => {
    it("nulls only the withheld members' emails", () => {
        const household = { id: 9, householdMembers: [{ id: 1, email: "kid@example.com" }, { id: 2, email: "parent@example.com" }] };
        expect(rosterHousehold(household, new Set([1])).householdMembers).toEqual([
            { id: 1, email: null },
            { id: 2, email: "parent@example.com" },
        ]);
    });
});

describe("withholdEmail", () => {
    it("nulls a withheld person's email and leaves others alone", () => {
        expect(withholdEmail({ id: 1, email: "kid@example.com" }, new Set([1])).email).toBeNull();
        expect(withholdEmail({ id: 2, email: "adult@example.com" }, new Set([1])).email).toBe("adult@example.com");
    });
});
