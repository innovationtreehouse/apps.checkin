/**
 * @jest-environment node
 *
 * The sysadmin role alone never shows a household's intake note
 * (docs/rules/membership.md); the Board, or a lead of that household, still sees it.
 * The full role matrix runs on the households GET; each other admin route that
 * returns a Household row is pinned to the same rule with a sysadmin-only caller.
 */

import type { NextRequest } from "next/server";
import { getServerSession } from "next-auth/next";
import prisma from "@/lib/prisma";
import { GET } from "@/app/api/membership-ops/households/route";
import { PATCH as householdPATCH } from "@/app/api/membership-ops/households/[id]/route";
import { PUT as participantPUT } from "@/app/api/membership-ops/participants/[id]/route";
import { POST as reassignPOST } from "@/app/api/membership-ops/participants/[id]/household/route";
import { canSeeIntakeNotes } from "@/lib/household/intakeNotes";

jest.mock("next-auth/next", () => ({ getServerSession: jest.fn() }));
jest.mock("@/lib/auth-options", () => ({ authOptions: {} }));
jest.mock("@/lib/logger", () => ({ logger: { error: jest.fn() }, logBackendError: jest.fn() }));
jest.mock("@/lib/getFullAttendance", () => ({ invalidateAttendanceCache: jest.fn() }));
jest.mock("@/lib/membership/selfGrantGuard", () => ({ refuseSelfGrant: jest.fn().mockResolvedValue(false), SELF_GRANT_REFUSAL_MESSAGE: "refused" }));
jest.mock("@/lib/roles", () => ({ ...jest.requireActual("@/lib/roles"), lockBoardRoles: jest.fn() }));
jest.mock("@/lib/membership/householdStatus", () => ({
    ...jest.requireActual("@/lib/membership/householdStatus"),
    lockAndFindDeniedHousehold: jest.fn().mockResolvedValue(null),
}));
jest.mock("@/lib/emergencyContacts/service", () => ({
    ...jest.requireActual("@/lib/emergencyContacts/service"),
    getPrimaryValidContact: jest.fn().mockResolvedValue(null),
}));
jest.mock("@/lib/prisma", () => {
    const tx = {
        person: { update: jest.fn(), updateMany: jest.fn(), findUniqueOrThrow: jest.fn() },
        auditLog: { create: jest.fn() },
        account: { deleteMany: jest.fn() },
    };
    return {
        __esModule: true,
        default: {
            household: { findUnique: jest.fn(), update: jest.fn() },
            boardSettings: { findUnique: jest.fn().mockResolvedValue(null) },
            person: { findUnique: jest.fn() },
            auditLog: { create: jest.fn() },
            $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
            tx,
        },
    };
});

const NOTE = "we are volunteer only; dad lost his job";
const HOUSEHOLD = { id: 10, name: "Test Household", intakeNotes: NOTE, line1: null, line2: null, city: null, state: null, postalCode: null };
const SYSADMIN_ONLY = { isSysadmin: true };
const mockSession = getServerSession as jest.Mock;
const db = prisma as unknown as {
    household: { findUnique: jest.Mock; update: jest.Mock };
    person: { findUnique: jest.Mock };
    tx: { person: { update: jest.Mock; updateMany: jest.Mock; findUniqueOrThrow: jest.Mock } };
};

function signIn(user: Record<string, unknown>) {
    mockSession.mockResolvedValue({ user: { id: 99, isSysadmin: false, isBoardMember: false, isKeyholder: false, isBackgroundCheckReviewer: false, isOperations: false, ...user } });
}

function request(url: string, method = "GET", body?: unknown) {
    return new Request(url, { method, headers: { cookie: "x=1" }, ...(body !== undefined && { body: JSON.stringify(body) }) }) as unknown as NextRequest;
}

async function detailNotes(user: Record<string, unknown>) {
    signIn(user);
    db.household.findUnique.mockResolvedValue({ ...HOUSEHOLD, householdMembers: [], orgMembership: null, emergencyContacts: [] });
    const res = await GET(request("http://localhost/api/membership-ops/households?id=10"));
    expect(res.status).toBe(200);
    return (await res.json()).household.intakeNotes;
}

beforeEach(() => jest.clearAllMocks());

describe("GET /api/membership-ops/households intake note", () => {
    it("is null for a sysadmin with no other role", async () => {
        expect(await detailNotes(SYSADMIN_ONLY)).toBeNull();
    });

    it("is null for a sysadmin who leads a different household", async () => {
        expect(await detailNotes({ isSysadmin: true, householdLead: true, householdId: 11 })).toBeNull();
    });

    it("is shown to a sysadmin who is a Board member", async () => {
        expect(await detailNotes({ isSysadmin: true, isBoardMember: true })).toBe(NOTE);
    });

    it("is shown to a sysadmin who leads that household", async () => {
        expect(await detailNotes({ isSysadmin: true, householdLead: true, householdId: 10 })).toBe(NOTE);
    });

    it("is shown to a Board member", async () => {
        expect(await detailNotes({ isBoardMember: true })).toBe(NOTE);
    });
});

describe("other admin routes returning a Household row: sysadmin-only caller gets no note", () => {
    it("PATCH /api/membership-ops/households/[id]", async () => {
        signIn(SYSADMIN_ONLY);
        db.household.findUnique.mockResolvedValue(HOUSEHOLD);
        db.household.update.mockResolvedValue({ ...HOUSEHOLD, name: "Renamed" });
        const res = await householdPATCH(request("http://localhost/api/membership-ops/households/10", "PATCH", { name: "Renamed" }), { params: Promise.resolve({ id: "10" }) });
        expect(res.status).toBe(200);
        const { household } = await res.json();
        expect(household.name).toBe("Renamed");
        expect(household.intakeNotes).toBeNull();
    });

    it("PUT /api/membership-ops/participants/[id]", async () => {
        signIn(SYSADMIN_ONLY);
        db.person.findUnique.mockResolvedValue({ name: "Old", nickname: null, email: null, phone: null, dateOfBirth: null, isDeclaredAdult: true, lastBackgroundCheck: null, householdId: 10, isHouseholdLead: true });
        db.tx.person.update.mockResolvedValue({ id: 5, name: "New", household: HOUSEHOLD });
        const res = await participantPUT(request("http://localhost/api/membership-ops/participants/5", "PUT", { name: "New" }), { params: Promise.resolve({ id: "5" }) });
        expect(res.status).toBe(200);
        const { participant } = await res.json();
        expect(participant.household.id).toBe(10);
        expect(participant.household.intakeNotes).toBeNull();
    });

    it("POST /api/membership-ops/participants/[id]/household", async () => {
        signIn(SYSADMIN_ONLY);
        db.person.findUnique.mockResolvedValue({ id: 5, name: "Mover", householdId: 20, mergedIntoId: null });
        db.household.findUnique.mockResolvedValue(HOUSEHOLD);
        db.tx.person.updateMany.mockResolvedValue({ count: 1 });
        db.tx.person.findUniqueOrThrow.mockResolvedValue({ id: 5, name: "Mover", householdId: 10, isHouseholdLead: false, household: HOUSEHOLD });
        const res = await reassignPOST(request("http://localhost/api/membership-ops/participants/5/household", "POST", { householdId: 10 }), { params: Promise.resolve({ id: "5" }) });
        expect(res.status).toBe(200);
        const { participant } = await res.json();
        expect(participant.household.id).toBe(10);
        expect(participant.household.intakeNotes).toBeNull();
    });
});

describe("canSeeIntakeNotes", () => {
    it("grants a lead of that household and the Board, never the sysadmin role alone", () => {
        expect(canSeeIntakeNotes({ householdLead: true, householdId: 10 }, 10)).toBe(true);
        expect(canSeeIntakeNotes({ householdLead: false, householdId: 10 }, 10)).toBe(false);
        expect(canSeeIntakeNotes({ isBoardMember: true }, 10)).toBe(true);
        expect(canSeeIntakeNotes({ isBoardMember: false, householdLead: false }, 10)).toBe(false);
    });
});
