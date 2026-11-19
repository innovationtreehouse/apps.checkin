/**
 * @jest-environment node
 *
 * GET /api/household sends each adult's computed background-check status, never
 * the check date, and the person and their household lead are the only readers.
 */
import type { NextRequest } from "next/server";
import { getServerSession } from "next-auth/next";
import prisma from "@/lib/prisma";
import { GET } from "@/app/api/household/route";

jest.mock("next-auth/next", () => ({ getServerSession: jest.fn() }));
jest.mock("@/lib/auth-options", () => ({ authOptions: {} }));
jest.mock("@/lib/logger", () => ({ logBackendError: jest.fn(), logger: { error: jest.fn() } }));
jest.mock("@/lib/orgMembership", () => ({ membershipValidThrough: jest.fn().mockResolvedValue(null) }));
jest.mock("@/lib/emailIdentity", () => ({ getEmailSenderIdentity: jest.fn().mockResolvedValue({ replyTo: null }) }));
jest.mock("@/lib/prisma", () => ({
    __esModule: true,
    default: { person: { findUnique: jest.fn(), findMany: jest.fn() }, boardSettings: { findUnique: jest.fn() } },
}));

const NOW = new Date(Date.UTC(2026, 2, 15, 18));
const SETTINGS = { orgMembershipYearBoundary: new Date(Date.UTC(2000, 8, 1)), bgRecheckMonths: 12 };
const LEAD = 1, ADULT = 2, YOUTH = 3, SIBLING = 4, UNCHECKED = 5;
const CHECKS: Record<number, Date | null> = {
    [LEAD]: new Date(Date.UTC(2025, 9, 1)),
    [ADULT]: new Date(Date.UTC(2024, 5, 1)),
    [YOUTH]: new Date(Date.UTC(2025, 9, 1)),
    [SIBLING]: new Date(Date.UTC(2025, 5, 1)),
    [UNCHECKED]: null,
};
const noCounts = { roles: 0, programsLed: 0, programVolunteers: 0, bgAttestationsAsSubject: 0, personBgProcesses: 0, toolStatuses: 0 };
const member = (id: number, adult: boolean) => ({
    id, name: `P${id}`, nickname: null, email: null, phone: null, allergies: null, householdId: 10,
    dateOfBirth: adult ? null : new Date(Date.UTC(2014, 0, 1)), isDeclaredAdult: adult, isHouseholdLead: id === LEAD,
    lastBackgroundCheck: CHECKS[id], canAccessStaging: false, _count: noCounts,
    budgetOwnersOwned: [], budgetOwnerTreasurerships: [], instancesLed: [], household: null,
});

async function get(callerId: number, settings: object | null = SETTINGS) {
    (getServerSession as jest.Mock).mockResolvedValue({ user: { id: callerId, householdId: 10 } });
    (prisma.person.findUnique as jest.Mock).mockImplementation(({ select }) => select.household
        ? Promise.resolve({ household: { id: 10, name: "H", householdMembers: [member(LEAD, true), member(ADULT, true), member(YOUTH, false), member(SIBLING, true), member(UNCHECKED, true)], orgMembership: null } })
        // householdLeadship, for the caller context.
        : Promise.resolve({ householdId: 10, isHouseholdLead: callerId === LEAD, isSysadmin: false }));
    (prisma.person.findMany as jest.Mock).mockResolvedValue([LEAD, ADULT, YOUTH, SIBLING, UNCHECKED].map((id) => ({ id })));
    (prisma.boardSettings.findUnique as jest.Mock).mockResolvedValue(settings);
    const res = await GET(new Request("http://localhost/api/household") as unknown as NextRequest);
    const body = await res.json();
    const statuses = Object.fromEntries(
        (body.household.householdMembers as { id: number; bgStatus?: unknown }[]).map((m) => [m.id, m.bgStatus]),
    );
    return { raw: JSON.stringify(body), statuses };
}

beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers({ now: NOW, doNotFake: ["nextTick", "setImmediate"] });
});
afterEach(() => jest.useRealTimers());

describe("GET /api/household bgStatus", () => {
    it("shows a lead every adult's status and no youth's", async () => {
        expect((await get(LEAD)).statuses).toEqual({
            [LEAD]: { personId: LEAD, status: "VALID" },
            [ADULT]: { personId: ADULT, status: "EXPIRED" },
            [YOUTH]: undefined,
            [SIBLING]: { personId: SIBLING, status: "EXPIRES_BEFORE_NEXT_YEAR" },
            [UNCHECKED]: { personId: UNCHECKED },
        });
    });

    it("shows a non-lead sibling only their own status", async () => {
        expect((await get(SIBLING)).statuses).toEqual({
            [LEAD]: { personId: LEAD },
            [ADULT]: { personId: ADULT },
            [YOUTH]: undefined,
            [SIBLING]: { personId: SIBLING, status: "EXPIRES_BEFORE_NEXT_YEAR" },
            // The same shape as an adult with a check, so a sibling cannot tell who has one on file.
            [UNCHECKED]: { personId: UNCHECKED },
        });
    });

    it("never sends a check date", async () => {
        for (const caller of [LEAD, SIBLING]) {
            const { raw } = await get(caller);
            expect(raw).not.toContain("lastBackgroundCheck");
            for (const d of Object.values(CHECKS)) if (d) expect(raw).not.toContain(d.toISOString().slice(0, 10));
        }
    });

    it("sends no status while the recheck interval is unset", async () => {
        for (const settings of [{ ...SETTINGS, bgRecheckMonths: 0 }, null]) {
            const { raw } = await get(LEAD, settings);
            expect(raw).not.toContain("bgStatus");
        }
    });
});
