/**
 * @jest-environment node
 *
 * Board ruling B15, 2026-10-27: a participant's own email is hidden from
 * program leaders while the participant is under 13.
 */
import { adultPhoneOnly, emailWithheldParticipants, leaderMaySeeEmail, rosterHousehold, rosterPerson, withholdEmail } from "@/lib/person/leaderEmail";

const today = new Date("2026-10-27T00:00:00Z");
const TURNS_13_TODAY = new Date("2013-10-27T00:00:00Z");
const TURNS_13_TOMORROW = new Date("2013-10-28T00:00:00Z");
const person = (dateOfBirth: Date | null) => ({ id: 1, name: "Kid", email: "kid@example.com", dateOfBirth });

describe("leaderMaySeeEmail", () => {
    it("hides under 13", () => expect(leaderMaySeeEmail(TURNS_13_TOMORROW, today)).toBe(false));
    it("shows on the 13th birthday", () => expect(leaderMaySeeEmail(TURNS_13_TODAY, today)).toBe(true));
    it("hides an unknown date of birth", () => expect(leaderMaySeeEmail(null, today)).toBe(false));
});

describe("rosterPerson", () => {
    it("nulls the email of an under-13 participant for a leader", () => {
        expect(rosterPerson(person(TURNS_13_TOMORROW), true, today)).toEqual({ id: 1, name: "Kid", email: null });
    });
    it("keeps the email of a 13-year-old for a leader", () => {
        expect(rosterPerson(person(TURNS_13_TODAY), true, today)).toEqual({ id: 1, name: "Kid", email: "kid@example.com" });
    });
    it("nulls the email when the date of birth is unknown", () => {
        expect(rosterPerson(person(null), true, today)).toEqual({ id: 1, name: "Kid", email: null });
    });
    it("leaves the email alone for a viewer who is not a leader, and never ships the date of birth", () => {
        expect(rosterPerson(person(TURNS_13_TOMORROW), false, today)).toEqual({ id: 1, name: "Kid", email: "kid@example.com" });
        expect(rosterPerson(person(null), false, today)).not.toHaveProperty("dateOfBirth");
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

describe("emailWithheldParticipants", () => {
    const participants = [
        { personId: 1, person: { dateOfBirth: TURNS_13_TOMORROW } },
        { personId: 2, person: { dateOfBirth: TURNS_13_TODAY } },
        { personId: 3, person: { dateOfBirth: null } },
    ];
    it("names under-13 and unknown date of birth for a leader", () => {
        expect([...emailWithheldParticipants(participants, true, today)]).toEqual([1, 3]);
    });
    it("names nobody for a viewer who is not a leader", () => {
        expect(emailWithheldParticipants(participants, false, today).size).toBe(0);
    });
});

describe("adultPhoneOnly", () => {
    const START = new Date("2027-01-10T00:00:00Z");
    const withPhone = (dateOfBirth: Date | null, isDeclaredAdult = false) => ({ ...person(dateOfBirth), phone: "5125551234", isDeclaredAdult });
    it("keeps the phone of a participant who is 18 on the program's start", () => {
        expect(adultPhoneOnly(withPhone(new Date("2009-01-10T00:00:00Z")), START).phone).toBe("5125551234");
    });
    // 18 today, 17 on the start date: the start decides.
    it("drops the phone of a participant under 18 on the program's start", () => {
        expect(adultPhoneOnly(withPhone(new Date("2008-10-27T00:00:00Z")), new Date("2026-10-26T00:00:00Z")).phone).toBeNull();
        expect(adultPhoneOnly(withPhone(new Date("2009-01-11T00:00:00Z")), START).phone).toBeNull();
    });
    it("drops the phone of a participant with no date of birth", () => {
        expect(adultPhoneOnly(withPhone(null), START).phone).toBeNull();
    });
    it("keeps the phone of a declared adult with no date of birth, and never ships the declaration", () => {
        const shipped = adultPhoneOnly(withPhone(null, true), START);
        expect(shipped.phone).toBe("5125551234");
        expect(shipped).not.toHaveProperty("isDeclaredAdult");
    });
});
