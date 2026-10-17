/**
 * @jest-environment node
 *
 * Finding 10: facility-trends period boundaries and labels were computed with
 * local calendar fields (`getDay`/`getMonth`/`setHours`) and rendered with
 * `toLocaleDateString` carrying no zone, so both followed the SERVER's timezone
 * instead of the org timezone every other server-side date path honors.
 *
 * The process timezone is pinned to America/Chicago and the org timezone is
 * America/New_York, so a visit in the first hour of a period in the org zone is
 * still the previous period in the server zone — the bucket and its label both
 * fail against the local-field implementation.
 */

import { getServerSession } from "next-auth/next";
import prisma from "@/lib/prisma";
import { pinTimezone } from "@/test-helpers/tz";
import { GET } from "@/app/api/facility/trends/route";
import type { TrendBucket } from "@/app/api/facility/trends/route";

jest.mock("next-auth/next", () => ({ getServerSession: jest.fn() }));
jest.mock("@/lib/auth-options", () => ({ authOptions: {} }));
jest.mock("@/lib/verify-kiosk", () => ({
    getKioskPublicKeys: jest.fn(() => []),
    verifyKioskSignature: jest.fn(() => ({ ok: false })),
}));
jest.mock("@/lib/prisma", () => ({
    __esModule: true,
    default: {
        appSettings: { upsert: jest.fn() },
        visit: { findMany: jest.fn() },
        programParticipant: { findMany: jest.fn() },
    },
}));

const mockSession = getServerSession as jest.Mock;
const mockUpsert = prisma.appSettings.upsert as unknown as jest.Mock;
const mockVisits = prisma.visit.findMany as unknown as jest.Mock;
const mockEnrollments = prisma.programParticipant.findMany as unknown as jest.Mock;

beforeEach(() => {
    jest.clearAllMocks();
    mockSession.mockResolvedValue({ user: { id: 1, isSysadmin: true } });
    mockUpsert.mockResolvedValue({ timezone: "America/New_York", locale: "en-US" });
    mockEnrollments.mockResolvedValue([]);
});

/** One completed visit; `arrivedAt` is the instant under test. */
function seedVisit(arrivedAtIso: string) {
    const arrivedAt = new Date(arrivedAtIso);
    mockVisits.mockResolvedValue([{
        id: 1,
        arrivedAt,
        departedAt: new Date(arrivedAt.getTime() + 60 * 60 * 1000),
        associatedEventId: null,
        person: { id: 1 },
        event: null,
    }]);
}

async function bucketFor(arrivedAtIso: string, period: string): Promise<TrendBucket> {
    seedVisit(arrivedAtIso);
    const res = await GET(new Request(`http://localhost/api/facility/trends?period=${period}`));
    const body = await res.json();
    expect(body.buckets).toHaveLength(1);
    return body.buckets[0];
}

describe("GET /api/facility/trends — buckets and labels use the org timezone", () => {
    pinTimezone();


    // 2026-03-01T05:30Z = Mar 1 00:30 in New York, but Feb 28 23:30 in Chicago.
    it("buckets a first-of-month visit into the org zone's month", async () => {
        const bucket = await bucketFor("2026-03-01T05:30:00.000Z", "month");
        expect(bucket.periodStart).toBe("2026-03-01T05:00:00.000Z");
        expect(bucket.label).toBe("March 2026");
    });

    // Same instant: Sunday in New York, still Saturday of the prior week in Chicago.
    it("buckets a week starting in the org zone", async () => {
        const bucket = await bucketFor("2026-03-01T05:30:00.000Z", "week");
        expect(bucket.periodStart).toBe("2026-03-01T05:00:00.000Z");
        expect(bucket.label).toBe("Mar 1 – Mar 7, 2026");
    });

    // 2026-04-01T04:30Z = Apr 1 00:30 EDT (Q2) but Mar 31 23:30 CDT (Q1).
    it("labels the quarter from the org zone", async () => {
        const bucket = await bucketFor("2026-04-01T04:30:00.000Z", "quarter");
        expect(bucket.periodStart).toBe("2026-04-01T04:00:00.000Z");
        expect(bucket.label).toBe("Q2 2026");
    });

    // 2026-01-01T05:30Z = Jan 1 00:30 in New York but Dec 31 23:30 in Chicago.
    it("labels the year from the org zone", async () => {
        const bucket = await bucketFor("2026-01-01T05:30:00.000Z", "year");
        expect(bucket.periodStart).toBe("2026-01-01T05:00:00.000Z");
        expect(bucket.label).toBe("2026");
    });
});
