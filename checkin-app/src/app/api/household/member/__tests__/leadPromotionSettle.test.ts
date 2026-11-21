/**
 * @jest-environment node
 *
 * A member save that makes someone a household lead settles the household's background
 * check after the save commits; a refused promotion settles nothing.
 */

import type { NextRequest } from "next/server";
import { getServerSession } from "next-auth/next";
import prisma from "@/lib/prisma";
import { settleAfterEvent } from "@/lib/membership/settleHouseholdBg";
import { PATCH } from "@/app/api/household/member/route";

// The archived-household guard has its own tests; here every household is live.
jest.mock("@/lib/household/archiveGuard", () => ({
    ...jest.requireActual("@/lib/household/archiveGuard"),
    lockLiveHouseholds: jest.fn(),
    lockLiveHouseholdsOf: jest.fn(),
}));

jest.mock("next-auth/next", () => ({ getServerSession: jest.fn() }));
jest.mock("@/lib/auth-options", () => ({ authOptions: {} }));
jest.mock("@/lib/logger", () => ({ logger: { error: jest.fn() }, logBackendError: jest.fn() }));
jest.mock("@/lib/getFullAttendance", () => ({ invalidateAttendanceCache: jest.fn() }));
jest.mock("@/lib/emergencyContacts/service", () => ({ reconcileAndWarn: jest.fn().mockResolvedValue(null) }));
jest.mock("@/lib/membership/householdStatus", () => ({ raiseDeniedHouseholdActivity: jest.fn() }));
jest.mock("@/lib/membership/settleHouseholdBg", () => ({ settleAfterEvent: jest.fn().mockResolvedValue([]) }));
jest.mock("@/lib/household/leads", () => ({
    ...jest.requireActual("@/lib/household/leads"),
    householdLeadship: jest.fn(),
    setsHouseholdAges: jest.fn().mockResolvedValue(true),
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
            budgetOwnersOwned: [],
            budgetOwnerTreasurerships: [],
            instancesLed: [],
        }));
    tx.person.update.mockResolvedValue({ id: OTHER });
    tx.person.findUnique.mockResolvedValue({ isHouseholdLead: false });
    addHouseholdLead.mockResolvedValue({ created: true });
});

describe("PATCH /api/household/member — lead promotion settles the household", () => {
    it("settles the household once the promotion commits", async () => {
        expect((await patchPromotion()).status).toBe(200);
        expect(settleAfterEvent).toHaveBeenCalledWith(HOUSEHOLD, "lead promotion", {}, { personId: OTHER });
    });

    it("settles nothing when the promotion is refused", async () => {
        addHouseholdLead.mockRejectedValue(new HouseholdLeadDeniedError(HOUSEHOLD, OTHER));
        expect((await patchPromotion()).status).toBe(200);
        expect(settleAfterEvent).not.toHaveBeenCalled();
    });
});
