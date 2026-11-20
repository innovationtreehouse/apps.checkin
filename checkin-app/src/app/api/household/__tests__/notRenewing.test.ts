/**
 * @jest-environment node
 *
 * GET /api/household carries the household's "won't renew" note while its year
 * stands, and null once that year has passed.
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
    default: { person: { findUnique: jest.fn() }, boardSettings: { findUnique: jest.fn() } },
}));

// Boundary 1 Sept: on 15 March 2026, outside the renewal window, the live membership year is 2025.
const BOUNDARY = new Date(Date.UTC(2020, 8, 1));
const NOW = new Date(Date.UTC(2026, 2, 15));

async function noteSeen(notRenewingYear: number | null) {
    (getServerSession as jest.Mock).mockResolvedValue({ user: { id: 1, householdId: 10 } });
    (prisma.person.findUnique as jest.Mock).mockResolvedValue({
        household: { id: 10, householdMembers: [], orgMembership: { status: "ACTIVE", householdId: 10, notRenewingYear } },
    });
    (prisma.boardSettings.findUnique as jest.Mock).mockResolvedValue({ orgMembershipYearBoundary: BOUNDARY });
    const res = await GET(new Request("http://localhost/api/household") as unknown as NextRequest);
    return (await res.json()).household.orgMembership.notRenewingYear;
}

beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers({ now: NOW, doNotFake: ["nextTick", "setImmediate"] });
});
afterEach(() => jest.useRealTimers());

describe("GET /api/household notRenewingYear", () => {
    it("keeps a note for the live year or a later one", async () => {
        expect(await noteSeen(2025)).toBe(2025);
        expect(await noteSeen(2026)).toBe(2026);
    });

    it("nulls a note whose year has passed", async () => {
        expect(await noteSeen(2024)).toBeNull();
    });

    it("keeps no note when there is none", async () => {
        expect(await noteSeen(null)).toBeNull();
    });
});
