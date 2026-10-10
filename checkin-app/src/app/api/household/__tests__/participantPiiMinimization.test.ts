/**
 * @jest-environment node
 *
 * Regression test for M1/M2 (Participant rows over-returned): household peers
 * and the full-access attendance feed must not carry INTERNAL-tier Participant
 * fields (role-flag booleans, googleId, lastBackgroundCheck, ...) or, for
 * attendance specifically, the raw email/googleId. Mocks prisma the way
 * scanRoute.test.ts / withAuth.test.ts do, so this runs in the default
 * (non-integration) suite with no live DB.
 */

import type { NextRequest } from "next/server";
import { getServerSession } from "next-auth/next";
import { getKioskPublicKeys, verifyKioskSignature } from "@/lib/verify-kiosk";
import prisma from "@/lib/prisma";
import { HOUSEHOLD_PEER_SELECT } from "@/lib/household/participantProjection";
import { LIVE_PERSON } from "@/lib/person/filters";
import { GET as householdGET } from "@/app/api/household/route";
import { GET as attendanceGET } from "@/app/api/attendance/route";

jest.mock("next-auth/next", () => ({ getServerSession: jest.fn() }));
jest.mock("@/lib/auth-options", () => ({ authOptions: {} }));
jest.mock("@/lib/verify-kiosk", () => ({
    getKioskPublicKeys: jest.fn(),
    verifyKioskSignature: jest.fn(),
}));
jest.mock("@/lib/logger", () => ({ logBackendError: jest.fn() }));
jest.mock("@/lib/prisma", () => ({
    __esModule: true,
    default: {
        person: { findUnique: jest.fn() },
        visit: { findMany: jest.fn() },
        // The supervising-adult test reads the board's background-check recheck
        // policy (#1436); unset here, which is the default.
        boardSettings: { findUnique: jest.fn() },
        // Full-access attendance carries the needReview aggregate (D7).
        rawBadgeLog: { count: jest.fn().mockResolvedValue(0) },
    },
}));

const mockSession = getServerSession as jest.Mock;
const mockPubKeys = getKioskPublicKeys as jest.Mock;
const mockVerify = verifyKioskSignature as jest.Mock;

beforeEach(() => {
    jest.clearAllMocks();
    mockPubKeys.mockReturnValue([]);
    mockVerify.mockReturnValue({ ok: false });
    mockSession.mockResolvedValue(null);
});

describe("Participant PII minimization (M1, M2)", () => {
    it("GET /api/household does not leak a peer's internal-tier fields", async () => {
        mockSession.mockResolvedValue({ user: { id: 1 } });

        // Full raw row as it exists in the DB, including everything a household
        // peer must never see (M2). The mock applies whatever `select` the route
        // actually requests — same as Prisma would — so this fails if the route
        // ever regresses back to `householdMembers: true`.
        const rawPeer = {
            id: 2,
            name: "Kid Two",
            email: "kid2@example.com",
            phone: "5551112222",
            dateOfBirth: new Date("2012-01-01"),
            isDeclaredAdult: false,
            isSysadmin: true,
            isBoardMember: false,
            isKeyholder: false,
            isBackgroundCheckReviewer: false,
            googleId: "g-123",
            emailVerified: new Date(),
            lastBackgroundCheck: new Date("2024-01-01"),
            waiverSignedBy: 1,
            notificationSettings: null,
            householdId: 10,
        } as Record<string, unknown>;

        (prisma.person.findUnique as jest.Mock).mockImplementation((args) => {
            const peerSelect = args.include.household.include.householdMembers.select as Record<string, boolean>;
            const projected = Object.fromEntries(
                Object.keys(peerSelect).filter((k) => peerSelect[k]).map((k) => [k, rawPeer[k]])
            );
            return Promise.resolve({
                id: 1,
                householdId: 10,
                household: {
                    id: 10,
                    name: "Test Household",
                    orgMembership: { id: 1, status: "ACTIVE", memberSince: new Date(), isVolunteer: false, householdId: 10 },
                    householdMembers: [projected],
                },
            });
        });

        const req = new Request("http://localhost/api/household") as unknown as NextRequest;
        const res = await householdGET(req);
        expect(res.status).toBe(200);

        const data = await res.json();
        const peer = data.household.householdMembers[0];

        // Safe fields survive.
        expect(peer.name).toBe("Kid Two");
        expect(peer.email).toBe("kid2@example.com");

        // INTERNAL-tier fields do not.
        expect(peer.isSysadmin).toBeUndefined();
        expect(peer.isBoardMember).toBeUndefined();
        expect(peer.isKeyholder).toBeUndefined();
        expect(peer.isBackgroundCheckReviewer).toBeUndefined();
        expect(peer.googleId).toBeUndefined();
        expect(peer.emailVerified).toBeUndefined();
        expect(peer.lastBackgroundCheck).toBeUndefined();
        expect(peer.waiverSignedBy).toBeUndefined();
        expect(peer.notificationSettings).toBeUndefined();

        // Pin the actual query shape, not just this test's mock.
        const callArgs = (prisma.person.findUnique as jest.Mock).mock.calls[0][0];
        expect(callArgs.include.household.include.householdMembers).toEqual({ where: LIVE_PERSON, select: HOUSEHOLD_PEER_SELECT });
    });

    // Household.intakeNotes is the family's free-text note TO the board (tier
    // 'pii', read by the BG-review queue). Household peers — including youth
    // with their own logins — must not receive a note a parent wrote about
    // them. Only the lead, who authored it and edits it on /my-household, does.
    describe("GET /api/household intakeNotes is lead-only", () => {
        const mockCaller = (caller: Record<string, unknown>) => {
            mockSession.mockResolvedValue({ user: { id: 1 } });
            (prisma.person.findUnique as jest.Mock).mockResolvedValue({
                id: 1,
                householdId: 10,
                ...caller,
                household: {
                    id: 10,
                    name: "Test Household",
                    line1: "123 Main St",
                    city: "Austin",
                    state: "TX",
                    postalCode: "78701",
                    intakeNotes: "we are volunteer only; dad lost his job",
                    orgMembership: null,
                    householdMembers: [],
                },
            });
        };

        const get = async () => {
            const req = new Request("http://localhost/api/household") as unknown as NextRequest;
            const res = await householdGET(req);
            expect(res.status).toBe(200);
            return (await res.json()).household;
        };

        it("strips the note for a non-lead household member", async () => {
            mockCaller({ isHouseholdLead: false, isSysadmin: false });
            const household = await get();

            expect(household.intakeNotes).toBeNull();
            // The address is shared household data the family authored — a peer
            // still gets it. Only the note is lead-gated.
            expect(household.line1).toBe("123 Main St");
            expect(household.postalCode).toBe("78701");
        });

        it("returns the note to a household lead", async () => {
            mockCaller({ isHouseholdLead: true, isSysadmin: false });
            expect((await get()).intakeNotes).toBe("we are volunteer only; dad lost his job");
        });

        it("returns the note to a sysadmin", async () => {
            mockCaller({ isHouseholdLead: false, isSysadmin: true });
            expect((await get()).intakeNotes).toBe("we are volunteer only; dad lost his job");
        });
    });

    it("GET /api/attendance (full access) does not leak email/googleId", async () => {
        // No session — admitted via a verified kiosk signature instead.
        mockPubKeys.mockReturnValue(["dummy-key"]);
        mockVerify.mockReturnValue({ ok: true });

        (prisma.visit.findMany as jest.Mock).mockResolvedValue([
            {
                id: 100,
                arrivedAt: new Date(),
                departedAt: null,
                person: {
                    id: 5,
                    email: "kid5@example.com",
                    name: null,
                    isKeyholder: false,
                    dateOfBirth: new Date("2015-06-01"),
                    householdId: 10,
                    phone: "5559998888",
                    household: { id: 10, emergencyContacts: [] },
                },
                event: null,
            },
        ]);

        const req = new Request("http://localhost/api/attendance", {
            headers: {
                "x-kiosk-signature": "sig",
                "x-kiosk-timestamp": "ts",
                "x-kiosk-nonce": "nonce",
            },
        }) as unknown as NextRequest;

        const res = await attendanceGET(req);
        expect(res.status).toBe(200);

        const data = await res.json();
        expect(data.access).toBe("full");

        const participant = data.attendance[0].participant;
        expect(participant.email).toBeUndefined();
        expect(participant.googleId).toBeUndefined();
        // Server-resolved name-or-email-prefix fallback still renders (M1).
        expect(participant.name).toBe("kid5");
    });
});
