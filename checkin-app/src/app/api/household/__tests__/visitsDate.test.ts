/**
 * @jest-environment node
 *
 * GET /api/household/visits refuses a `date` filter that does not parse.
 */
import type { NextRequest } from "next/server";
import { getServerSession } from "next-auth/next";
import prisma from "@/lib/prisma";
import { GET } from "@/app/api/household/visits/route";

jest.mock("next-auth/next", () => ({ getServerSession: jest.fn() }));
jest.mock("@/lib/auth-options", () => ({ authOptions: {} }));
jest.mock("@/lib/logger", () => ({ logBackendError: jest.fn(), logger: { error: jest.fn() } }));
jest.mock("@/lib/prisma", () => ({
    __esModule: true,
    default: { person: { findUnique: jest.fn() }, visit: { findMany: jest.fn() } },
}));

const get = (query: string) =>
    GET(new Request(`http://localhost/api/household/visits${query}`) as unknown as NextRequest);

beforeEach(() => {
    jest.clearAllMocks();
    (getServerSession as jest.Mock).mockResolvedValue({ user: { id: 1, householdId: 10 } });
    (prisma.person.findUnique as jest.Mock).mockResolvedValue({ householdId: 10 });
    (prisma.visit.findMany as jest.Mock).mockResolvedValue([]);
});

describe("GET /api/household/visits date filter", () => {
    it("returns 400 for a malformed date without querying", async () => {
        const res = await get("?date=not-a-date");

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: "Invalid date" });
        expect(prisma.visit.findMany).not.toHaveBeenCalled();
    });

    it("accepts a yyyy-mm-dd date", async () => {
        const res = await get("?date=2026-11-01");

        expect(res.status).toBe(200);
        expect(prisma.visit.findMany).toHaveBeenCalledTimes(1);
    });
});
