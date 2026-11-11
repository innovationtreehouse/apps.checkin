/**
 * @jest-environment node
 *
 * A youth cannot edit their own record here, as on the profile route; an unknown
 * date of birth reads as adult. Adults and leads editing others are unaffected, and
 * a declaration never lands beside a date already on file.
 */

import type { NextRequest } from "next/server";
import { getServerSession } from "next-auth/next";
import prisma from "@/lib/prisma";
import { PATCH } from "@/app/api/household/member/route";

jest.mock("next-auth/next", () => ({ getServerSession: jest.fn() }));
jest.mock("@/lib/auth-options", () => ({ authOptions: {} }));
jest.mock("@/lib/logger", () => ({ logger: { error: jest.fn() } }));
jest.mock("@/lib/getFullAttendance", () => ({ invalidateAttendanceCache: jest.fn() }));
jest.mock("@/lib/emergencyContacts/service", () => ({ reconcileAndWarn: jest.fn().mockResolvedValue(null) }));
jest.mock("@/lib/household/leads", () => ({
    ...jest.requireActual("@/lib/household/leads"),
    householdLeadship: jest.fn(),
}));

const tx = {
    person: { update: jest.fn(), findUnique: jest.fn() },
    auditLog: { create: jest.fn() },
};
jest.mock("@/lib/prisma", () => ({
    __esModule: true,
    default: {
        person: { findUnique: jest.fn() },
        $transaction: jest.fn((fn: (t: unknown) => unknown) => fn(tx)),
    },
}));

const { householdLeadship } = jest.requireMock("@/lib/household/leads") as { householdLeadship: jest.Mock };
const mockSession = getServerSession as jest.Mock;
const findPerson = prisma.person.findUnique as jest.Mock;

const ME = 1;
const CHILD = 3;
const YOUTH_DOB = new Date(new Date().getFullYear() - 14, 0, 1);
const ADULT_DOB = new Date(new Date().getFullYear() - 22, 0, 1);

function person(id: number, dateOfBirth: Date | null, isDeclaredAdult = false) {
    return {
        id,
        householdId: 10,
        email: null,
        dateOfBirth,
        isDeclaredAdult,
        lastBackgroundCheck: null,
        canAccessStaging: false,
        household: { orgMembership: { isVolunteerFamily: false } },
        _count: { accounts: 1, roles: 0, programsLed: 0, programVolunteers: 0, bgAttestationsAsSubject: 0, personBgProcesses: 0, toolStatuses: 0 },
    };
}

function patch(body: Record<string, unknown>) {
    return PATCH(new Request("http://localhost/api/household/member", {
        method: "PATCH",
        body: JSON.stringify(body),
    }) as unknown as NextRequest);
}

function written() {
    return tx.person.update.mock.calls[0][0].data;
}

beforeEach(() => {
    jest.clearAllMocks();
    mockSession.mockResolvedValue({ user: { id: ME } });
    householdLeadship.mockResolvedValue({ householdId: 10, canManage: false });
    tx.person.update.mockImplementation(({ where }) => Promise.resolve({ id: where.id }));
});

describe("PATCH /api/household/member — youth self-edit", () => {
    it.each([
        ["age fields", { dob: "", over25: true }],
        ["a changed date", { dob: "2000-01-01" }],
        ["a non-age field", { phone: "5125551234" }],
    ])("refuses a youth editing their own %s, writing nothing", async (_label, fields) => {
        findPerson.mockResolvedValue(person(ME, YOUTH_DOB));
        const res = await patch({ participantId: ME, ...fields });
        expect(res.status).toBe(403);
        expect((await res.json()).error).toBe("Youth profiles are read-only.");
        expect(tx.person.update).not.toHaveBeenCalled();
    });

    it("refuses a youth who can manage the household, as a lead or sysadmin can", async () => {
        householdLeadship.mockResolvedValue({ householdId: 10, canManage: true });
        findPerson.mockResolvedValue(person(ME, YOUTH_DOB));
        const res = await patch({ participantId: ME, phone: "5125551234" });
        expect(res.status).toBe(403);
        expect(tx.person.update).not.toHaveBeenCalled();
    });

    it("lets an adult edit their own record", async () => {
        findPerson.mockResolvedValue(person(ME, ADULT_DOB));
        const res = await patch({ participantId: ME, name: "New Name" });
        expect(res.status).toBe(200);
        expect(written().name).toBe("New Name");
    });

    it("reads an unknown date of birth as adult", async () => {
        findPerson.mockResolvedValue(person(ME, null));
        const res = await patch({ participantId: ME, name: "New Name" });
        expect(res.status).toBe(200);
    });

    it("lets a lead edit a child's non-age field, leaving the age fields alone", async () => {
        householdLeadship.mockResolvedValue({ householdId: 10, canManage: true });
        findPerson.mockResolvedValue(person(CHILD, YOUTH_DOB));
        const res = await patch({ participantId: CHILD, allergies: "peanuts" });
        expect(res.status).toBe(200);
        expect(written().allergies).toBe("peanuts");
        expect(written()).not.toHaveProperty("dateOfBirth");
        expect(written()).not.toHaveProperty("isDeclaredAdult");
    });

    it("stores no declaration beside a date already on file", async () => {
        householdLeadship.mockResolvedValue({ householdId: 10, canManage: true });
        findPerson.mockResolvedValue(person(CHILD, YOUTH_DOB));
        const res = await patch({ participantId: CHILD, over25: true });
        expect(res.status).toBe(200);
        expect(written().isDeclaredAdult).toBe(false);
        expect(written()).not.toHaveProperty("dateOfBirth");
    });
});

describe("PATCH /api/household/member — declaring someone over 25", () => {
    beforeEach(() => {
        householdLeadship.mockResolvedValue({ householdId: 10, canManage: true });
    });

    it.each([[""], [null]])("refuses replacing an under-18 date with a declaration (dob %j), writing nothing", async (dob) => {
        findPerson.mockResolvedValue(person(CHILD, YOUTH_DOB));
        const res = await patch({ participantId: CHILD, dob, over25: true });
        expect(res.status).toBe(400);
        expect((await res.json()).error).toMatch(/under 18/);
        expect(tx.person.update).not.toHaveBeenCalled();
    });

    it("accepts an older date typed over an under-18 date, storing the declaration instead", async () => {
        findPerson.mockResolvedValue(person(CHILD, YOUTH_DOB));
        expect((await patch({ participantId: CHILD, dob: "1990-01-01", over25: true })).status).toBe(200);
        expect(written()).toMatchObject({ dateOfBirth: null, isDeclaredAdult: true });
    });

    it("accepts a declaration in a later save once the date is cleared", async () => {
        findPerson.mockResolvedValue(person(CHILD, YOUTH_DOB));
        expect((await patch({ participantId: CHILD, dob: "", over25: false })).status).toBe(200);
        expect(written()).toMatchObject({ dateOfBirth: null, isDeclaredAdult: false });

        findPerson.mockResolvedValue(person(CHILD, null));
        expect((await patch({ participantId: CHILD, dob: "", over25: true })).status).toBe(200);
        expect(tx.person.update.mock.calls[1][0].data).toMatchObject({ dateOfBirth: null, isDeclaredAdult: true });
    });

    it("lets a lead declare an adult with no date on file", async () => {
        findPerson.mockResolvedValue(person(CHILD, null));
        expect((await patch({ participantId: CHILD, dob: "", over25: true })).status).toBe(200);
        expect(written().isDeclaredAdult).toBe(true);
    });

    it("lets an adult declare themself over 25 in place of a date of 18 or over", async () => {
        findPerson.mockResolvedValue(person(ME, ADULT_DOB));
        expect((await patch({ participantId: ME, dob: "", over25: true })).status).toBe(200);
        expect(written()).toMatchObject({ dateOfBirth: null, isDeclaredAdult: true });
    });
});
