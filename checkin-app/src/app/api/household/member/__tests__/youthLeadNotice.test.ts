/**
 * @jest-environment node
 *
 * A member save that gives a household lead an under-18 date of birth still saves,
 * and the Board is emailed once, after the save commits.
 */

import type { NextRequest } from "next/server";
import { getServerSession } from "next-auth/next";
import prisma from "@/lib/prisma";
import { emailBoardMembers } from "@/lib/emailRecipients";
import { PATCH } from "@/app/api/household/member/route";

jest.mock("next-auth/next", () => ({ getServerSession: jest.fn() }));
jest.mock("@/lib/auth-options", () => ({ authOptions: {} }));
jest.mock("@/lib/logger", () => ({ logger: { error: jest.fn() }, logBackendError: jest.fn() }));
jest.mock("@/lib/emailRecipients", () => ({ emailBoardMembers: jest.fn().mockResolvedValue(1) }));
jest.mock("@/lib/getFullAttendance", () => ({ invalidateAttendanceCache: jest.fn() }));
// The archived-household guard has its own tests; here every household is live.
jest.mock("@/lib/household/archiveGuard", () => ({
    ...jest.requireActual("@/lib/household/archiveGuard"),
    lockLiveHouseholds: jest.fn(),
}));
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
        person: { findUnique: jest.fn(), findMany: jest.fn() },
        $transaction: jest.fn((fn: (t: unknown) => unknown) => fn(tx)),
    },
}));

const { householdLeadship } = jest.requireMock("@/lib/household/leads") as { householdLeadship: jest.Mock };
const findMany = prisma.person.findMany as jest.Mock;
const email = jest.mocked(emailBoardMembers);

const ME = 1;
const CO_LEAD = 3;
const HOUSEHOLD = 10;
const yearsAgo = (n: number) => new Date(Date.UTC(new Date().getUTCFullYear() - n, 0, 1));
const UNDER_18 = yearsAgo(15);

function coLead(dateOfBirth: Date | null) {
    return {
        id: CO_LEAD,
        householdId: HOUSEHOLD,
        email: null,
        dateOfBirth,
        isDeclaredAdult: false,
        isHouseholdLead: true,
        lastBackgroundCheck: null,
        canAccessStaging: false,
        household: { orgMembership: { isVolunteerFamily: false } },
        _count: { accounts: 0, roles: 0, programsLed: 0, programVolunteers: 0, bgAttestationsAsSubject: 0, personBgProcesses: 0, toolStatuses: 0 },
    };
}

function saveDob(onFile: Date | null) {
    (prisma.person.findUnique as jest.Mock).mockResolvedValue(coLead(onFile));
    return PATCH(new Request("http://localhost/api/household/member", {
        method: "PATCH",
        body: JSON.stringify({ participantId: CO_LEAD, dob: UNDER_18.toISOString().slice(0, 10) }),
    }) as unknown as NextRequest);
}

beforeEach(() => {
    jest.clearAllMocks();
    (getServerSession as jest.Mock).mockResolvedValue({ user: { id: ME } });
    householdLeadship.mockResolvedValue({ householdId: HOUSEHOLD, canManage: true });
    tx.person.update.mockResolvedValue({ id: CO_LEAD });
    findMany.mockResolvedValue([{ name: "Sam Lee", dateOfBirth: UNDER_18, household: { id: HOUSEHOLD, name: "Lee" } }]);
});

describe("PATCH /api/household/member — a lead given an under-18 date", () => {
    it("saves the date and emails the Board", async () => {
        const res = await saveDob(null);

        expect(res.status).toBe(200);
        expect(tx.person.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ dateOfBirth: UNDER_18 }) }));
        expect(email).toHaveBeenCalledTimes(1);
        expect(email).toHaveBeenCalledWith("board.youthHouseholdLead", expect.objectContaining({ personName: "Sam Lee", householdName: "Lee" }), expect.any(String));
    });

    it("sends nothing when the same under-18 date is saved again", async () => {
        const res = await saveDob(UNDER_18);

        expect(res.status).toBe(200);
        expect(email).not.toHaveBeenCalled();
    });

    it("still reports the save when the notice fails", async () => {
        findMany.mockRejectedValue(new Error("db down"));

        const res = await saveDob(null);

        expect(res.status).toBe(200);
        expect((await res.json()).message).toBe("Household member updated successfully.");
        expect(email).not.toHaveBeenCalled();
    });
});
