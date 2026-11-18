/**
 * @jest-environment node
 *
 * One lock decides both the household member edit's refusal and the disabled
 * email field on the my-household cards.
 */

import { isEmailLocked, type EmailLockFields } from "@/lib/person/emailLock";

const NONE = { accounts: 0, roles: 0, programsLed: 0, programVolunteers: 0, bgAttestationsAsSubject: 0, personBgProcesses: 0, toolStatuses: 0 };

function member(overrides: Partial<EmailLockFields> = {}, counts: Partial<typeof NONE> = {}): EmailLockFields {
    return {
        lastBackgroundCheck: null,
        canAccessStaging: false,
        _count: { ...NONE, ...counts },
        budgetOwnersOwned: [],
        budgetOwnerTreasurerships: [],
        instancesLed: [],
        household: { orgMembership: { isVolunteerFamily: false } },
        ...overrides,
    };
}

describe("isEmailLocked", () => {
    it("leaves a member with no sign-in and no grant editable", () => {
        expect(isEmailLocked(member())).toBe(false);
        expect(isEmailLocked(member({ household: { orgMembership: null } }))).toBe(false);
    });

    it.each<[string, EmailLockFields]>([
        ["a linked sign-in", member({}, { accounts: 1 })],
        ["a role", member({}, { roles: 1 })],
        ["a program they lead", member({}, { programsLed: 1 })],
        ["a program instance they lead", member({ instancesLed: [{ id: 1 }] })],
        ["a program volunteer row", member({}, { programVolunteers: 1 })],
        ["a background-check attestation", member({}, { bgAttestationsAsSubject: 1 })],
        ["a background-check process", member({}, { personBgProcesses: 1 })],
        ["a recorded background check", member({ lastBackgroundCheck: new Date("2026-01-01") })],
        ["a tool certification level", member({}, { toolStatuses: 1 })],
        ["staging access", member({ canAccessStaging: true })],
        ["a bucket they own", member({ budgetOwnersOwned: [{ id: 5 }] })],
        ["a bucket treasurership", member({ budgetOwnerTreasurerships: [{ budgetOwnerId: 5 }] })],
        ["a Volunteer Family household", member({ household: { orgMembership: { isVolunteerFamily: true } } })],
    ])("locks the email of a member with %s", (_label, row) => {
        expect(isEmailLocked(row)).toBe(true);
    });
});
