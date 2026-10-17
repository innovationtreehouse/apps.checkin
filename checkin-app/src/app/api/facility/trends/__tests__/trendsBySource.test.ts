/**
 * @jest-environment node
 *
 * Issue #1676: `bySource` decomposes a bucket's HOURS by `arrivedVia`, alongside
 * the existing volunteer/participant and structured/unstructured splits. It must
 * never decompose unique-people counts — one person can carry more than one
 * source in the same bucket (a scan AND a roster mark), so per-source unique
 * counts would not sum to `uniqueVolunteers`/`uniqueParticipants`.
 */

import { getServerSession } from "next-auth/next";
import prisma from "@/lib/prisma";
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

function visit(id: number, personId: number, arrivedVia: string | null, hours: number) {
    const arrivedAt = new Date("2026-03-10T15:00:00.000Z");
    return {
        id,
        arrivedAt,
        departedAt: new Date(arrivedAt.getTime() + hours * 60 * 60 * 1000),
        associatedEventId: null,
        arrivedVia,
        person: { id: personId },
        event: null,
    };
}

async function fetchBucket(): Promise<TrendBucket> {
    // person 3 carries TWO sources in the same bucket (SCANNER and LEAD_MARKED) —
    // the case the issue calls out where per-source people counts would double-count.
    mockVisits.mockResolvedValue([
        visit(1, 1, "SCANNER", 2),
        visit(2, 2, "WEB", 1),
        visit(3, 3, "SCANNER", 1),
        visit(4, 3, "LEAD_MARKED", 1),
        visit(5, 4, null, 0.5),
    ]);
    const res = await GET(new Request("http://localhost/api/facility/trends?period=month"));
    const body = await res.json();
    expect(body.buckets).toHaveLength(1);
    return body.buckets[0];
}

describe("GET /api/facility/trends — bySource", () => {
    it("sums bySource hours to the bucket total", async () => {
        const bucket = await fetchBucket();

        expect(bucket.bySource).toEqual({
            SCANNER: 3, // person 1 (2h) + person 3 (1h)
            WEB: 1,
            LEAD_MARKED: 1,
            UNSPECIFIED: 0.5,
        });

        const bySourceSum = Object.values(bucket.bySource).reduce((s, h) => s + h, 0);
        const bucketTotal = bucket.totalVolunteerHours + bucket.totalParticipantHours;
        expect(bySourceSum).toBeCloseTo(bucketTotal, 5);
        expect(bySourceSum).toBeCloseTo(bucket.structuredHours + bucket.unstructuredHours, 5);
    });

    it("does not decompose unique-people counts by source", async () => {
        const bucket = await fetchBucket();

        // Person 3 has both a SCANNER and a LEAD_MARKED visit here; if unique counts
        // were summed per-source they would double-count that person (SCANNER 2 +
        // LEAD_MARKED 1 + WEB 1 = 4). The real count stays whole at 4 unique people —
        // no double-counting, and no per-source count field exists at all.
        expect(bucket.uniqueVolunteers).toBe(4);
        expect(bucket.uniqueParticipants).toBe(0);

        // bySource values are hours (numbers) only — never a people count or an object.
        for (const value of Object.values(bucket.bySource)) {
            expect(typeof value).toBe("number");
        }
        expect(bucket).not.toHaveProperty("uniqueVolunteersBySource");
        expect(bucket).not.toHaveProperty("uniqueParticipantsBySource");
        expect(bucket).not.toHaveProperty("bySourcePeople");
    });
});
