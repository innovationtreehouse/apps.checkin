/**
 * @jest-environment node
 *
 * Finding 8: the ±7-day visit-filter window is built from a date-only string
 * that parses to UTC midnight, so the arithmetic must be UTC too. `getDate` /
 * `setDate` read and write LOCAL calendar fields, which on a server west of UTC
 * carries the server's DST offset into the bounds — the window edge lands an
 * hour off, clipping visits at the boundary.
 *
 * Runs with the process timezone pinned to America/Chicago; the assertions are
 * exact UTC instants, so they fail against the local-field implementation.
 */

import { getServerSession } from "next-auth/next";
import prisma from "@/lib/prisma";
import { pinTimezone } from "@/test-helpers/tz";
import { GET as profileVisitsGET } from "@/app/api/profile/visits/route";
import { GET as householdVisitsGET } from "@/app/api/household/visits/route";

jest.mock("next-auth/next", () => ({ getServerSession: jest.fn() }));
jest.mock("@/lib/auth-options", () => ({ authOptions: {} }));
jest.mock("@/lib/verify-kiosk", () => ({
    getKioskPublicKeys: jest.fn(() => []),
    verifyKioskSignature: jest.fn(() => ({ ok: false })),
}));
jest.mock("@/lib/prisma", () => ({
    __esModule: true,
    default: {
        person: { findUnique: jest.fn() },
        visit: { findMany: jest.fn() },
    },
}));

const mockSession = getServerSession as jest.Mock;
const mockFindMany = prisma.visit.findMany as unknown as jest.Mock;
const mockPersonFindUnique = prisma.person.findUnique as unknown as jest.Mock;

beforeEach(() => {
    jest.clearAllMocks();
    mockSession.mockResolvedValue({ user: { id: 1 } });
    mockFindMany.mockResolvedValue([]);
    mockPersonFindUnique.mockResolvedValue({ householdId: 7 });
});

async function windowFor(
    route: (req: Request) => Promise<unknown>,
    date: string
): Promise<{ gte: Date; lte: Date }> {
    await route(new Request(`http://localhost/api/visits?date=${date}`));
    expect(mockFindMany).toHaveBeenCalledTimes(1);
    return mockFindMany.mock.calls[0][0].where.arrivedAt;
}

describe.each([
    ["GET /api/profile/visits", profileVisitsGET as unknown as (req: Request) => Promise<unknown>],
    ["GET /api/household/visits", householdVisitsGET as unknown as (req: Request) => Promise<unknown>],
])("%s — ±7-day window is UTC", (_name, route) => {
    pinTimezone();


    // 2026-03-04 parses to 2026-03-04T00:00:00Z = Mar 3 18:00 in Chicago, so the
    // local day-of-month (3) differs from the UTC one (4). The +7 edge crosses the
    // 2026-03-08 DST start, where local-field arithmetic yields 2026-03-10T23:00Z.
    it("does not drag the upper bound across a DST start", async () => {
        const { gte, lte } = await windowFor(route, "2026-03-04");
        expect(gte.toISOString()).toBe("2026-02-25T00:00:00.000Z");
        expect(lte.toISOString()).toBe("2026-03-11T00:00:00.000Z");
    });

    // Mirror case: the -7 edge crosses the same DST start going backwards, where
    // local-field arithmetic yields 2026-03-04T01:00Z.
    it("does not drag the lower bound across a DST start", async () => {
        const { gte, lte } = await windowFor(route, "2026-03-11");
        expect(gte.toISOString()).toBe("2026-03-04T00:00:00.000Z");
        expect(lte.toISOString()).toBe("2026-03-18T00:00:00.000Z");
    });

    it("centers the window on the requested UTC day away from DST", async () => {
        const { gte, lte } = await windowFor(route, "2026-08-15");
        expect(gte.toISOString()).toBe("2026-08-08T00:00:00.000Z");
        expect(lte.toISOString()).toBe("2026-08-22T00:00:00.000Z");
    });
});
