/**
 * @jest-environment node
 *
 * The sysadmin role alone never shows a household's intake note
 * (docs/rules/membership.md); the Board, or a lead of that household, still sees it.
 */

import type { NextRequest } from "next/server";
import { getServerSession } from "next-auth/next";
import prisma from "@/lib/prisma";
import { GET } from "@/app/api/membership-ops/households/route";
import { canSeeIntakeNotes } from "@/lib/household/intakeNotes";

jest.mock("next-auth/next", () => ({ getServerSession: jest.fn() }));
jest.mock("@/lib/auth-options", () => ({ authOptions: {} }));
jest.mock("@/lib/logger", () => ({ logger: { error: jest.fn() }, logBackendError: jest.fn() }));
jest.mock("@/lib/prisma", () => ({
    __esModule: true,
    default: {
        household: { findUnique: jest.fn() },
        boardSettings: { findUnique: jest.fn().mockResolvedValue(null) },
    },
}));

const NOTE = "we are volunteer only; dad lost his job";
const mockSession = getServerSession as jest.Mock;

async function detailNotes(user: Record<string, unknown>) {
    mockSession.mockResolvedValue({ user: { id: 99, isSysadmin: false, isBoardMember: false, isKeyholder: false, isBackgroundCheckReviewer: false, isOperations: false, ...user } });
    (prisma.household.findUnique as jest.Mock).mockResolvedValue({
        id: 10, name: "Test Household", intakeNotes: NOTE,
        householdMembers: [], orgMembership: null, emergencyContacts: [],
    });
    const req = new Request("http://localhost/api/membership-ops/households?id=10", { headers: { cookie: "x=1" } }) as unknown as NextRequest;
    const res = await GET(req);
    expect(res.status).toBe(200);
    return (await res.json()).household.intakeNotes;
}

describe("GET /api/membership-ops/households intake note", () => {
    it("is null for a sysadmin with no other role", async () => {
        expect(await detailNotes({ isSysadmin: true })).toBeNull();
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

describe("canSeeIntakeNotes", () => {
    it("grants a lead of that household and the Board, never the sysadmin role alone", () => {
        expect(canSeeIntakeNotes({ householdLead: true, householdId: 10 }, 10)).toBe(true);
        expect(canSeeIntakeNotes({ householdLead: false, householdId: 10 }, 10)).toBe(false);
        expect(canSeeIntakeNotes({ isBoardMember: true }, 10)).toBe(true);
        expect(canSeeIntakeNotes({ isBoardMember: false, householdLead: false }, 10)).toBe(false);
    });
});
