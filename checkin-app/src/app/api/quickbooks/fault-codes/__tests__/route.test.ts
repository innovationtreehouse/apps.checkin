/**
 * @jest-environment node
 *
 * The QuickBooks fault codes route reads the six stored fields of every row,
 * newest last-seen first, under the `codes` envelope.
 */
import type { NextRequest } from "next/server";
import { getServerSession } from "next-auth/next";
import prisma from "@/lib/prisma";
import { GET } from "../route";

jest.mock("next-auth/next", () => ({ getServerSession: jest.fn() }));
jest.mock("@/lib/auth-options", () => ({ authOptions: {} }));
jest.mock("@/lib/prisma", () => ({
    __esModule: true,
    default: { qboFaultCodeSeen: { findMany: jest.fn() } },
}));

const findMany = (prisma as unknown as { qboFaultCodeSeen: { findMany: jest.Mock } }).qboFaultCodeSeen.findMany;
const mockSession = getServerSession as jest.Mock;

const ROW = {
    code: "6000",
    kind: "data",
    count: 14,
    firstSeenAt: new Date("2026-11-03T10:00:00.000Z"),
    lastSeenAt: new Date("2026-11-20T09:12:00.000Z"),
    lastLane: "expense posting",
};

const get = () => GET(new Request("http://localhost/api/quickbooks/fault-codes") as unknown as NextRequest, { params: Promise.resolve({}) });

beforeEach(() => {
    findMany.mockReset();
    mockSession.mockResolvedValue({ user: { id: 7, isFinance: true } });
});

it("returns every row newest last-seen first, selecting only the stored fields", async () => {
    findMany.mockResolvedValue([ROW]);
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ codes: [{ ...ROW, firstSeenAt: ROW.firstSeenAt.toISOString(), lastSeenAt: ROW.lastSeenAt.toISOString() }] });
    expect(findMany).toHaveBeenCalledWith({
        select: { code: true, kind: true, count: true, firstSeenAt: true, lastSeenAt: true, lastLane: true },
        orderBy: [{ lastSeenAt: "desc" }, { code: "asc" }, { kind: "asc" }],
    });
});

it("refuses a caller without finance, board or sysadmin before querying", async () => {
    mockSession.mockResolvedValue({ user: { id: 8, isKeyholder: true } });
    const res = await get();
    expect(res.status).toBe(403);
    expect(findMany).not.toHaveBeenCalled();
});
