/**
 * @jest-environment node
 *
 * The households GET selects only the columns its pages read, and every
 * household-editing route refuses an archived household.
 */

import type { NextRequest } from "next/server";
import { getServerSession } from "next-auth/next";
import prisma from "@/lib/prisma";
import { GET } from "@/app/api/membership-ops/households/route";
import { PATCH as settingsPATCH } from "@/app/api/household/settings/route";
import { PATCH as householdPATCH } from "@/app/api/membership-ops/households/[id]/route";
import { PUT as participantPUT } from "@/app/api/membership-ops/participants/[id]/route";
import { POST as reassignPOST } from "@/app/api/membership-ops/participants/[id]/household/route";
import { ArchivedHouseholdError, lockLiveHouseholds } from "@/lib/household/archiveGuard";
import { householdCheckStandings } from "@/lib/membership/checkStanding";

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
jest.mock("@/lib/membership/selfGrantGuard", () => ({ refuseSelfGrant: jest.fn().mockResolvedValue(false), findSelfGrantRefusal: jest.fn().mockResolvedValue(null), recordSelfGrantRefusal: jest.fn(), SELF_GRANT_REFUSAL_MESSAGE: "refused" }));
jest.mock("@/lib/roles", () => ({ ...jest.requireActual("@/lib/roles"), lockBoardRoles: jest.fn() }));
jest.mock("@/lib/membership/householdStatus", () => ({
    ...jest.requireActual("@/lib/membership/householdStatus"),
    lockAndFindDeniedHousehold: jest.fn().mockResolvedValue(null),
}));
jest.mock("@/lib/emergencyContacts/service", () => ({
    ...jest.requireActual("@/lib/emergencyContacts/service"),
    getPrimaryValidContact: jest.fn().mockResolvedValue(null),
}));
jest.mock("@/lib/membership/checkStanding", () => ({
    ...jest.requireActual("@/lib/membership/checkStanding"),
    householdCheckStandings: jest.fn().mockResolvedValue({ members: [], awaitingNaming: false }),
}));
jest.mock("@/lib/prisma", () => {
    const household = { findUnique: jest.fn(), findMany: jest.fn(), update: jest.fn() };
    const tx = {
        household,
        person: { update: jest.fn(), updateMany: jest.fn(), findUnique: jest.fn(), findUniqueOrThrow: jest.fn(), count: jest.fn() },
        auditLog: { create: jest.fn() },
        account: { deleteMany: jest.fn() },
        $executeRaw: jest.fn(),
        $queryRaw: jest.fn(),
    };
    return {
        __esModule: true,
        default: {
            household,
            boardSettings: { findUnique: jest.fn().mockResolvedValue(null) },
            person: { findUnique: jest.fn() },
            auditLog: { create: jest.fn(), findMany: jest.fn() },
            $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
            tx,
        },
    };
});

const HOUSEHOLD = { id: 10, name: "Test Household", line1: null, line2: null, city: null, state: null, postalCode: null };
const SYSADMIN_ONLY = { isSysadmin: true };
const mockSession = getServerSession as jest.Mock;
const db = prisma as unknown as {
    household: { findUnique: jest.Mock; findMany: jest.Mock; update: jest.Mock };
    person: { findUnique: jest.Mock };
    boardSettings: { findUnique: jest.Mock };
    auditLog: { findMany: jest.Mock };
    tx: { person: { update: jest.Mock; updateMany: jest.Mock; findUnique: jest.Mock; findUniqueOrThrow: jest.Mock; count: jest.Mock } };
};

function signIn(user: Record<string, unknown>) {
    mockSession.mockResolvedValue({ user: { id: 99, isSysadmin: false, isBoardMember: false, isKeyholder: false, isBackgroundCheckReviewer: false, isOperations: false, ...user } });
}

function request(url: string, method = "GET", body?: unknown) {
    return new Request(url, { method, headers: { cookie: "x=1" }, ...(body !== undefined && { body: JSON.stringify(body) }) }) as unknown as NextRequest;
}

beforeEach(() => jest.clearAllMocks());

describe("GET /api/membership-ops/households", () => {
    it("selects the detail columns the household page and Edit Info modal read", async () => {
        signIn({ isBoardMember: true });
        db.household.findUnique.mockResolvedValue({ ...HOUSEHOLD, archivedAt: null, householdMembers: [], orgMembership: null, emergencyContacts: [] });
        const res = await GET(request("http://localhost/api/membership-ops/households?id=10"));
        expect(res.status).toBe(200);

        const args = db.household.findUnique.mock.calls[0][0];
        expect(args).not.toHaveProperty("include");
        expect(Object.keys(args.select).sort()).toEqual(
            ["archivedAt", "city", "emergencyContacts", "householdMembers", "id", "line1", "line2", "name", "orgMembership", "postalCode", "state"],
        );
        expect(args.select.orgMembership).toEqual({ select: { id: true, status: true, memberSince: true, isVolunteerFamily: true } });
    });

    it("flags only a disputed member, and sends nothing about the review", async () => {
        signIn({ isBoardMember: true });
        const member = (id: number) => ({ id, name: `P${id}`, email: null, isHouseholdLead: true, lastBackgroundCheck: null, dateOfBirth: null, programParticipants: [] });
        db.household.findUnique.mockResolvedValue({ ...HOUSEHOLD, archivedAt: null, householdMembers: [member(1), member(2)], orgMembership: null, emergencyContacts: [] });
        (householdCheckStandings as jest.Mock).mockResolvedValueOnce({
            members: [{ personId: 1, isHouseholdLead: true, standing: "DISPUTED", disputing: [{ id: 7 }] }, { personId: 2, isHouseholdLead: true, standing: "NONE", disputing: [] }],
            awaitingNaming: false,
        });
        const body = await (await GET(request("http://localhost/api/membership-ops/households?id=10"))).json();
        expect(body.household.householdMembers.map((m: { id: number; disputed: boolean }) => [m.id, m.disputed])).toEqual([[1, true], [2, false]]);
        expect(JSON.stringify(body)).not.toMatch(/disputing|standing/);
    });

    it("selects only the list columns the households page and pickers read", async () => {
        signIn({ isBoardMember: true });
        db.household.findMany.mockResolvedValue([{ id: 10, name: "Test Household", householdMembers: [], orgMembership: { status: "ACTIVE", memberSince: null, processes: [] } }]);
        const res = await GET(request("http://localhost/api/membership-ops/households"));
        expect(res.status).toBe(200);

        const args = db.household.findMany.mock.calls[0][0];
        expect(args).not.toHaveProperty("include");
        expect(Object.keys(args.select).sort()).toEqual(["householdMembers", "id", "name", "orgMembership"]);
        expect(Object.keys(args.select.orgMembership.select).sort()).toEqual(["id", "memberSince", "notRenewingYear", "processes", "status"]);
        const [row] = (await res.json()).households;
        expect(Object.keys(row).sort()).toEqual(["awaitingPayment", "awaitingPaymentYear", "bgValidUntil", "householdMembers", "id", "name", "notRenewing", "orgMembership", "settledForComingYear", "validUntil"]);
        expect(row.orgMembership).toEqual({ status: "ACTIVE", memberSince: null });
        expect(row.notRenewing).toBeNull();
    });

    it("labels a household that said it won't renew into the noted year, with the date it said so", async () => {
        signIn({ isBoardMember: true });
        jest.useFakeTimers({ now: new Date(Date.UTC(2026, 6, 15)), doNotFake: ["nextTick", "setImmediate"] });
        try {
            db.boardSettings.findUnique.mockResolvedValueOnce({ orgMembershipYearBoundary: new Date(Date.UTC(2020, 8, 1)), bgRecheckMonths: 0 });
            const said = new Date(Date.UTC(2026, 6, 3));
            db.auditLog.findMany.mockResolvedValueOnce([
                { affectedEntityId: 9, timestamp: new Date(Date.UTC(2025, 6, 3)), newData: { notRenewingYear: 2025 } },
                { affectedEntityId: 9, timestamp: said, newData: { notRenewingYear: 2026 } },
                { affectedEntityId: 9, timestamp: new Date(Date.UTC(2026, 6, 4)), newData: { status: "ACTIVE" } },
            ]);
            db.household.findMany.mockResolvedValue([
                { id: 10, name: "Noted", householdMembers: [], orgMembership: { id: 9, status: "ACTIVE", memberSince: null, notRenewingYear: 2026, processes: [] } },
                { id: 11, name: "Old note", householdMembers: [], orgMembership: { id: 8, status: "ACTIVE", memberSince: null, notRenewingYear: 2025, processes: [] } },
            ]);
            const res = await GET(request("http://localhost/api/membership-ops/households"));
            const [noted, old] = (await res.json()).households;
            expect(noted.notRenewing).toEqual({ year: 2026, since: said.toISOString() });
            expect(noted.orgMembership).toEqual({ status: "ACTIVE", memberSince: null });
            expect(old.notRenewing).toBeNull();
            expect(db.auditLog.findMany.mock.calls[0][0].where).toMatchObject({ tableName: "OrgMembership", affectedEntityId: { in: [9] } });
        } finally {
            jest.useRealTimers();
        }
    });
});

describe("admin routes returning a Household row", () => {
    it("PATCH /api/membership-ops/households/[id]", async () => {
        signIn(SYSADMIN_ONLY);
        db.household.findUnique.mockResolvedValue(HOUSEHOLD);
        db.household.update.mockResolvedValue({ ...HOUSEHOLD, name: "Renamed" });
        const res = await householdPATCH(request("http://localhost/api/membership-ops/households/10", "PATCH", { name: "Renamed" }), { params: Promise.resolve({ id: "10" }) });
        expect(res.status).toBe(200);
        const { household } = await res.json();
        expect(household.name).toBe("Renamed");
    });

    it("PATCH /api/membership-ops/households/[id] answers 409 when the household was archived mid-edit", async () => {
        signIn(SYSADMIN_ONLY);
        db.household.findUnique.mockResolvedValue(HOUSEHOLD);
        (lockLiveHouseholds as jest.Mock).mockRejectedValueOnce(new ArchivedHouseholdError());
        const res = await householdPATCH(request("http://localhost/api/membership-ops/households/10", "PATCH", { name: "Renamed" }), { params: Promise.resolve({ id: "10" }) });
        expect(res.status).toBe(409);
        expect(db.household.update).not.toHaveBeenCalled();
    });

    it("PUT /api/membership-ops/participants/[id]", async () => {
        signIn(SYSADMIN_ONLY);
        db.person.findUnique.mockResolvedValue({ name: "Old", nickname: null, email: null, phone: null, dateOfBirth: null, isDeclaredAdult: true, lastBackgroundCheck: null, householdId: 10, isHouseholdLead: true });
        db.tx.person.update.mockResolvedValue({ id: 5, name: "New", household: HOUSEHOLD });
        const res = await participantPUT(request("http://localhost/api/membership-ops/participants/5", "PUT", { name: "New" }), { params: Promise.resolve({ id: "5" }) });
        expect(res.status).toBe(200);
        const { participant } = await res.json();
        expect(participant.household.id).toBe(10);
    });

    it("POST /api/membership-ops/participants/[id]/household", async () => {
        signIn(SYSADMIN_ONLY);
        db.person.findUnique.mockResolvedValue({ id: 5, name: "Mover", householdId: 20 });
        db.household.findUnique.mockResolvedValue(HOUSEHOLD);
        db.tx.person.findUnique.mockResolvedValue({ householdId: 20, isHouseholdLead: false });
        db.tx.person.updateMany.mockResolvedValue({ count: 1 });
        db.tx.person.findUniqueOrThrow.mockResolvedValue({ id: 5, name: "Mover", householdId: 10, isHouseholdLead: false, household: HOUSEHOLD });
        const res = await reassignPOST(request("http://localhost/api/membership-ops/participants/5/household", "POST", { householdId: 10 }), { params: Promise.resolve({ id: "5" }) });
        expect(res.status).toBe(200);
        const { participant } = await res.json();
        expect(participant.household.id).toBe(10);
    });

    it("POST /api/membership-ops/participants/[id]/household refuses moving the household's only lead", async () => {
        signIn(SYSADMIN_ONLY);
        db.person.findUnique.mockResolvedValue({ id: 5, name: "Mover", householdId: 20 });
        db.household.findUnique.mockResolvedValue(HOUSEHOLD);
        db.tx.person.findUnique.mockResolvedValue({ householdId: 20, isHouseholdLead: true });
        db.tx.person.count.mockResolvedValue(1);
        const res = await reassignPOST(request("http://localhost/api/membership-ops/participants/5/household", "POST", { householdId: 10 }), { params: Promise.resolve({ id: "5" }) });
        expect(res.status).toBe(409);
        expect(db.tx.person.updateMany).not.toHaveBeenCalled();
        expect(db.tx.person.update).not.toHaveBeenCalled();
    });
});

describe("an archived household refuses the change", () => {
    beforeEach(() => (lockLiveHouseholds as jest.Mock).mockRejectedValueOnce(new ArchivedHouseholdError()));

    it("PATCH /api/household/settings", async () => {
        signIn({});
        db.person.findUnique.mockResolvedValue({ householdId: 10, isHouseholdLead: true, isSysadmin: false });
        const res = await settingsPATCH(request("http://localhost/api/household/settings", "PATCH", { emergencyContactName: "Pat Example" }));
        expect(res.status).toBe(409);
        expect(db.household.update).not.toHaveBeenCalled();
    });

    it("PUT /api/membership-ops/participants/[id]", async () => {
        signIn(SYSADMIN_ONLY);
        db.person.findUnique.mockResolvedValue({ name: "Old", nickname: null, email: null, phone: null, dateOfBirth: null, isDeclaredAdult: true, lastBackgroundCheck: null, householdId: 10, isHouseholdLead: true });
        const res = await participantPUT(request("http://localhost/api/membership-ops/participants/5", "PUT", { name: "New" }), { params: Promise.resolve({ id: "5" }) });
        expect(res.status).toBe(409);
        expect(db.tx.person.update).not.toHaveBeenCalled();
    });

    it("POST /api/membership-ops/participants/[id]/household, into or out of it", async () => {
        signIn(SYSADMIN_ONLY);
        db.person.findUnique.mockResolvedValue({ id: 5, name: "Mover", householdId: 20 });
        db.household.findUnique.mockResolvedValue(HOUSEHOLD);
        const res = await reassignPOST(request("http://localhost/api/membership-ops/participants/5/household", "POST", { householdId: 10 }), { params: Promise.resolve({ id: "5" }) });
        expect(res.status).toBe(409);
        expect(lockLiveHouseholds).toHaveBeenCalledWith(expect.anything(), [20, 10]);
        expect(db.tx.person.updateMany).not.toHaveBeenCalled();
    });
});
