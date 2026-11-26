/**
 * @jest-environment node
 */
import prisma from "@/lib/prisma";
import { resolveBoundary } from "@/lib/outreach/render";

let mockOrgZone = "America/Chicago";
jest.mock("@/lib/appSettings", () => ({
    orgToday: async (now: Date) => jest.requireActual<typeof import("@/lib/time")>("@/lib/time").calendarDayIn(now, mockOrgZone),
}));

jest.mock("@/lib/prisma", () => ({
    __esModule: true,
    default: { boardSettings: { findUnique: jest.fn() } },
}));

// 8 PM on Aug 31 in Chicago, already Sept 1 in UTC.
const EVENING_BEFORE = new Date("2026-09-01T01:00:00Z");

describe("resolveBoundary ({{deadline}})", () => {
    beforeEach(() => {
        jest.mocked(prisma.boardSettings.findUnique).mockResolvedValue({ orgMembershipYearBoundary: new Date("2000-09-01T00:00:00Z") } as never);
    });

    it("is still this year's boundary on the org's evening before it", async () => {
        mockOrgZone = "America/Chicago";
        expect((await resolveBoundary(EVENING_BEFORE)).toISOString()).toBe("2026-09-01T00:00:00.000Z");
    });

    it("is next year's once the boundary day has begun in the org's zone", async () => {
        mockOrgZone = "UTC";
        expect((await resolveBoundary(EVENING_BEFORE)).toISOString()).toBe("2027-09-01T00:00:00.000Z");
    });
});
