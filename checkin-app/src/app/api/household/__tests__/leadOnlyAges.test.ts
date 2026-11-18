/**
 * @jest-environment node
 *
 * Once a household has a lead, only a lead sets or changes a member's date of
 * birth or over-25 declaration, their own included. A household with no lead is
 * unchanged.
 */

import type { NextRequest } from "next/server";
import { getServerSession } from "next-auth/next";
import prisma from "@/lib/prisma";
import { PATCH as householdPATCH } from "@/app/api/household/route";
import { PATCH as memberPATCH } from "@/app/api/household/member/route";
import { AGE_LEAD_ONLY_REFUSAL } from "@/lib/person/adultDob";

// The archived-household guard has its own tests; here every household is live.
jest.mock("@/lib/household/archiveGuard", () => ({
    ...jest.requireActual("@/lib/household/archiveGuard"),
    lockLiveHouseholds: jest.fn(),
    lockLiveHouseholdsOf: jest.fn(),
}));

jest.mock("next-auth/next", () => ({ getServerSession: jest.fn() }));
jest.mock("@/lib/auth-options", () => ({ authOptions: {} }));
jest.mock("@/lib/logger", () => ({ logger: { error: jest.fn() } }));
jest.mock("@/lib/person/mailAliases", () => ({ removeAliasesForSignInEmail: jest.fn() }));
jest.mock("@/lib/getFullAttendance", () => ({ invalidateAttendanceCache: jest.fn() }));
jest.mock("@/lib/emergencyContacts/service", () => ({ reconcileAndWarn: jest.fn().mockResolvedValue(null) }));
jest.mock("@/lib/membership/boardAlerts", () => ({ notifyBoardOfYouthLeads: jest.fn() }));
jest.mock("@/lib/person/mintId", () => ({ mintPersonId: jest.fn().mockResolvedValue(99) }));
jest.mock("@/lib/household/leads", () => ({
    ...jest.requireActual("@/lib/household/leads"),
    householdLeadship: jest.fn(),
}));

const tx = {
    person: { update: jest.fn(), create: jest.fn(), findUnique: jest.fn() },
    auditLog: { create: jest.fn() },
};
jest.mock("@/lib/prisma", () => ({
    __esModule: true,
    default: {
        person: { findUnique: jest.fn(), findMany: jest.fn() },
        $transaction: jest.fn((fn: (t: unknown) => unknown) => fn(tx)),
    },
}));

const { householdLeadship } = jest.requireMock("@/lib/household/leads") as { householdLeadship: jest.Mock };
const mockSession = getServerSession as jest.Mock;
const findPerson = prisma.person.findUnique as jest.Mock;
const findLeads = prisma.person.findMany as jest.Mock;

const LEAD = 1;
const SYSADMIN = 2;
const NON_LEAD = 3;
const CHILD = 4;
const CHILD_DOB = new Date("2015-03-01");

function person(id: number, dateOfBirth: Date | null, isDeclaredAdult = false) {
    return {
        id,
        householdId: 10,
        email: null,
        dateOfBirth,
        isDeclaredAdult,
        isHouseholdLead: id === LEAD,
        lastBackgroundCheck: null,
        canAccessStaging: false,
        household: { orgMembership: { isVolunteerFamily: false } },
        _count: { accounts: 1, roles: 0, programsLed: 0, programVolunteers: 0, bgAttestationsAsSubject: 0, personBgProcesses: 0, toolStatuses: 0 },
        budgetOwnersOwned: [],
        budgetOwnerTreasurerships: [],
        instancesLed: [],
    };
}

function signInAs(id: number, canManage: boolean) {
    mockSession.mockResolvedValue({ user: { id, householdId: 10, email: `p${id}@example.com` } });
    householdLeadship.mockResolvedValue({ householdId: 10, canManage });
}

function call(handler: (req: NextRequest) => Promise<Response>, path: string, body: Record<string, unknown>) {
    return handler(new Request(`http://localhost${path}`, { method: "PATCH", body: JSON.stringify(body) }) as unknown as NextRequest);
}
const editMember = (body: Record<string, unknown>) => call(memberPATCH, "/api/household/member", body);
const addMember = (body: Record<string, unknown>) => call(householdPATCH, "/api/household", body);

beforeEach(() => {
    jest.clearAllMocks();
    findLeads.mockResolvedValue([{ id: LEAD }]);
    tx.person.update.mockImplementation(({ where }) => Promise.resolve({ id: where.id }));
    tx.person.create.mockImplementation(({ data }) => Promise.resolve({ id: data.id, email: null, name: data.name }));
});

describe("PATCH /api/household/member — ages in a household with a lead", () => {
    it("lets the lead change a member's date of birth", async () => {
        signInAs(LEAD, true);
        findPerson.mockResolvedValue(person(CHILD, CHILD_DOB));
        expect((await editMember({ participantId: CHILD, dob: "2014-03-01" })).status).toBe(200);
        expect(tx.person.update.mock.calls[0][0].data.dateOfBirth).toEqual(new Date("2014-03-01"));
    });

    it("lets the lead change their own date of birth", async () => {
        signInAs(LEAD, true);
        findPerson.mockResolvedValue(person(LEAD, null));
        expect((await editMember({ participantId: LEAD, dob: "", over25: true })).status).toBe(200);
    });

    it.each([
        ["a new date", { dob: "1990-01-01" }],
        ["an over-25 declaration", { dob: "", over25: true }],
    ])("refuses a non-lead setting their own age by %s, writing nothing", async (_label, fields) => {
        signInAs(NON_LEAD, false);
        findPerson.mockResolvedValue(person(NON_LEAD, null));
        const res = await editMember({ participantId: NON_LEAD, ...fields });
        expect(res.status).toBe(403);
        expect((await res.json()).error).toBe(AGE_LEAD_ONLY_REFUSAL);
        expect(tx.person.update).not.toHaveBeenCalled();
    });

    it("lets a non-lead save other fields while the form resends their age unchanged", async () => {
        signInAs(NON_LEAD, false);
        findPerson.mockResolvedValue(person(NON_LEAD, null, true));
        expect((await editMember({ participantId: NON_LEAD, name: "New Name", dob: "", over25: true })).status).toBe(200);
        expect(tx.person.update.mock.calls[0][0].data.name).toBe("New Name");
    });

    it("refuses a sysadmin who does not lead the household changing a member's date of birth", async () => {
        signInAs(SYSADMIN, true);
        findPerson.mockResolvedValue(person(CHILD, CHILD_DOB));
        const res = await editMember({ participantId: CHILD, dob: "2014-03-01" });
        expect(res.status).toBe(403);
        expect(tx.person.update).not.toHaveBeenCalled();
    });
});

describe("PATCH /api/household/member — ages in a household with no lead", () => {
    beforeEach(() => findLeads.mockResolvedValue([]));

    it("lets a member set their own date of birth", async () => {
        signInAs(NON_LEAD, false);
        findPerson.mockResolvedValue(person(NON_LEAD, null));
        expect((await editMember({ participantId: NON_LEAD, dob: "1990-01-01" })).status).toBe(200);
    });

    it("lets a sysadmin set a member's date of birth", async () => {
        signInAs(SYSADMIN, true);
        findPerson.mockResolvedValue(person(CHILD, CHILD_DOB));
        expect((await editMember({ participantId: CHILD, dob: "2014-03-01" })).status).toBe(200);
    });
});

describe("PATCH /api/household — adding a member", () => {
    const NEW_KID = { memberName: "New Kid", memberDob: "2016-01-01" };

    it("lets the lead add a member with a date of birth", async () => {
        signInAs(LEAD, true);
        expect((await addMember(NEW_KID)).status).toBe(200);
        expect(tx.person.create).toHaveBeenCalled();
    });

    it("refuses a sysadmin who does not lead the household, creating nothing", async () => {
        signInAs(SYSADMIN, true);
        const res = await addMember(NEW_KID);
        expect(res.status).toBe(403);
        expect((await res.json()).error).toBe(AGE_LEAD_ONLY_REFUSAL);
        expect(tx.person.create).not.toHaveBeenCalled();
    });

    it("lets a sysadmin add a member to a household with no lead", async () => {
        findLeads.mockResolvedValue([]);
        signInAs(SYSADMIN, true);
        expect((await addMember(NEW_KID)).status).toBe(200);
    });
});
