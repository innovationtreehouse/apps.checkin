/**
 * @jest-environment node
 *
 * The board item for a lead promotion refused on a denied household is raised after
 * the member edit commits, so its failure is logged and the save still reads as saved.
 */

import type { NextRequest } from "next/server";
import { getServerSession } from "next-auth/next";
import prisma from "@/lib/prisma";
import { logger, logBackendError } from "@/lib/logger";
import { raiseDeniedHouseholdActivity } from "@/lib/membership/householdStatus";
import { PATCH } from "@/app/api/household/member/route";

jest.mock("next-auth/next", () => ({ getServerSession: jest.fn() }));
jest.mock("@/lib/auth-options", () => ({ authOptions: {} }));
jest.mock("@/lib/logger", () => ({ logger: { error: jest.fn() }, logBackendError: jest.fn() }));
jest.mock("@/lib/getFullAttendance", () => ({ invalidateAttendanceCache: jest.fn() }));
jest.mock("@/lib/emergencyContacts/service", () => ({ reconcileAndWarn: jest.fn().mockResolvedValue(null) }));
jest.mock("@/lib/membership/householdStatus", () => ({ raiseDeniedHouseholdActivity: jest.fn() }));
jest.mock("@/lib/household/leads", () => ({
    ...jest.requireActual("@/lib/household/leads"),
    householdLeadship: jest.fn(),
    addHouseholdLead: jest.fn(),
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

const { householdLeadship, addHouseholdLead, HouseholdLeadDeniedError } = jest.requireMock("@/lib/household/leads") as {
    householdLeadship: jest.Mock;
    addHouseholdLead: jest.Mock;
    HouseholdLeadDeniedError: new (householdId: number, personId: number) => Error;
};
const raise = raiseDeniedHouseholdActivity as jest.Mock;

const ME = 1;
const OTHER = 3;
const HOUSEHOLD = 10;

function patchPromotion() {
    return PATCH(new Request("http://localhost/api/household/member", {
        method: "PATCH",
        body: JSON.stringify({ participantId: OTHER, phone: "5125551234", isLead: true }),
    }) as unknown as NextRequest);
}

beforeEach(() => {
    jest.clearAllMocks();
    (getServerSession as jest.Mock).mockResolvedValue({ user: { id: ME } });
    householdLeadship.mockResolvedValue({ householdId: HOUSEHOLD, canManage: true });
    (prisma.person.findUnique as jest.Mock).mockImplementation(({ where }) => Promise.resolve(where.id === ME
        ? { isHouseholdLead: true }
        : {
            id: OTHER,
            householdId: HOUSEHOLD,
            email: null,
            dateOfBirth: null,
            isDeclaredAdult: false,
            isHouseholdLead: false,
            lastBackgroundCheck: null,
            canAccessStaging: false,
            household: { orgMembership: { isVolunteerFamily: false } },
            _count: { accounts: 0, roles: 0, programsLed: 0, programVolunteers: 0, bgAttestationsAsSubject: 0, personBgProcesses: 0, toolStatuses: 0 },
        }));
    tx.person.update.mockResolvedValue({ id: OTHER });
    tx.person.findUnique.mockResolvedValue({ isHouseholdLead: false });
    addHouseholdLead.mockRejectedValue(new HouseholdLeadDeniedError(HOUSEHOLD, OTHER));
});

describe("PATCH /api/household/member — denied household raise after commit", () => {
    it("reports the saved edit and logs the failure when the raise throws", async () => {
        const failure = new Error("raise failed");
        raise.mockRejectedValue(failure);

        const res = await patchPromotion();

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.message).toBe("Household member updated, but not added as a lead.");
        expect(body.leadRejection).toBe(new HouseholdLeadDeniedError(HOUSEHOLD, OTHER).message);
        const ref = { householdId: HOUSEHOLD, personId: OTHER };
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("raise failed"), ref, failure);
        expect(logBackendError).toHaveBeenCalledWith(failure, expect.stringContaining("/api/household/member"), ref);
    });

    it("logs nothing when the raise succeeds", async () => {
        raise.mockResolvedValue(undefined);

        const res = await patchPromotion();

        expect(res.status).toBe(200);
        expect(raise).toHaveBeenCalledWith({ householdId: HOUSEHOLD, personId: OTHER, what: "household lead promotion refused" });
        expect(logger.error).not.toHaveBeenCalled();
        expect(logBackendError).not.toHaveBeenCalled();
    });
});
