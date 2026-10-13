/**
 * @jest-environment node
 *
 * GET /api/household carries the same derived valid-until households-ops shows
 * (membershipValidThrough), and only for an ACTIVE household.
 */
import type { NextRequest } from "next/server";
import { getServerSession } from "next-auth/next";
import prisma from "@/lib/prisma";
import { membershipValidThrough } from "@/lib/orgMembership";
import { GET } from "@/app/api/household/route";

jest.mock("next-auth/next", () => ({ getServerSession: jest.fn() }));
jest.mock("@/lib/auth-options", () => ({ authOptions: {} }));
jest.mock("@/lib/logger", () => ({ logBackendError: jest.fn(), logger: { error: jest.fn() } }));
jest.mock("@/lib/orgMembership", () => ({ membershipValidThrough: jest.fn() }));
jest.mock("@/lib/emailIdentity", () => ({ getEmailSenderIdentity: jest.fn().mockResolvedValue({ replyTo: null }) }));
jest.mock("@/lib/prisma", () => ({
    __esModule: true,
    default: { person: { findUnique: jest.fn() } },
}));

const VALID = new Date(Date.UTC(2026, 8, 1));

async function getAs(status: string) {
    (getServerSession as jest.Mock).mockResolvedValue({ user: { id: 1 } });
    (prisma.person.findUnique as jest.Mock).mockResolvedValue({
        id: 1,
        isHouseholdLead: true,
        household: { id: 10, orgMembership: { id: 1, status }, householdMembers: [] },
    });
    (membershipValidThrough as jest.Mock).mockResolvedValue(VALID);
    const res = await GET(new Request("http://localhost/api/household") as unknown as NextRequest);
    return res.json();
}

beforeEach(() => jest.clearAllMocks());

describe("GET /api/household validUntil", () => {
    it("ACTIVE → membershipValidThrough for the household", async () => {
        expect((await getAs("ACTIVE")).validUntil).toBe(VALID.toISOString());
        expect(membershipValidThrough).toHaveBeenCalledWith(10);
    });

    it.each(["NONE", "REVOKED", "DENIED"])("%s → null", async (status) => {
        expect((await getAs(status)).validUntil).toBeNull();
        expect(membershipValidThrough).not.toHaveBeenCalled();
    });
});
