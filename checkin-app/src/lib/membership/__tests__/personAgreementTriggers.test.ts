import prisma from "@/lib/prisma";
import type { TxClient } from "@/lib/db-client";
import { closePersonAgreementOnLead, membershipYearAt, openPersonAgreement, openPersonAgreementOnEngage, previousMembershipYear, runPersonAgreementSweep } from "@/lib/membership/personAgreementTriggers";

let mockOrgZone = "America/Chicago";
jest.mock("@/lib/appSettings", () => ({
    orgToday: async (now: Date) => jest.requireActual<typeof import("@/lib/time")>("@/lib/time").calendarDayIn(now, mockOrgZone),
}));

jest.mock("@/lib/prisma", () => ({
    __esModule: true,
    default: { $transaction: jest.fn(), boardSettings: { findUnique: jest.fn() }, person: { findMany: jest.fn() } },
}));

/**
 * The pure year arithmetic behind PERSON_AGREEMENT, and the failure handling of the
 * yearly pass and the open on taking part. Who is picked is pinned by the DB-backed test.
 */

const BOUNDARY = new Date("2000-09-01"); // anchor day-of-year; the year is irrelevant
// A real instant on 2 August, mid-morning in the org's zone, and the day it falls on.
const NOW = new Date("2026-08-02T15:00:00.000Z");
const TODAY = new Date("2026-08-02T00:00:00.000Z");

describe("membershipYearAt — the year a new agreement is counted from", () => {
    it("starts at the latest boundary on or before today", () => {
        expect(membershipYearAt(BOUNDARY, TODAY)).toEqual({ start: new Date("2025-09-01"), end: new Date("2026-09-01") });
        expect(membershipYearAt(BOUNDARY, new Date("2026-09-01"))).toEqual({ start: new Date("2026-09-01"), end: new Date("2027-09-01") });
    });

    it("does not move early for the renewal window", () => {
        // Two weeks before the boundary, renewals are open, but the year in progress is still the old one.
        expect(membershipYearAt(BOUNDARY, new Date("2026-08-18")).start).toEqual(new Date("2025-09-01"));
    });

    it("the previous year ends where this one starts", () => {
        const year = membershipYearAt(BOUNDARY, TODAY);
        expect(previousMembershipYear(year)).toEqual({ start: new Date("2024-09-01"), end: year.start });
    });
});

describe("openPersonAgreement — the per-person transaction", () => {
    it("runs with the explicit 15-second timeout", async () => {
        const transaction = jest.mocked(prisma.$transaction);
        transaction.mockResolvedValue(null as never);

        await openPersonAgreement(1, TODAY, NOW);

        expect(transaction.mock.calls[0]?.[1]).toEqual({ maxWait: 5_000, timeout: 15_000 });
    });
});

describe("runPersonAgreementSweep — the yearly pass, one person's failure", () => {
    it("counts it and still opens the rest", async () => {
        jest.mocked(prisma.boardSettings.findUnique).mockResolvedValue({ orgMembershipYearBoundary: BOUNDARY } as never);
        jest.mocked(prisma.person.findMany).mockResolvedValue([{ id: 1 }, { id: 2 }] as never);
        jest.mocked(prisma.$transaction).mockRejectedValueOnce(new Error("lock timeout")).mockResolvedValueOnce({ id: 9 } as never);

        const errors = jest.spyOn(console, "error").mockImplementation(() => {});

        const result = await runPersonAgreementSweep(NOW);

        expect(result).toMatchObject({ opened: 1, failed: 1 });
        expect(errors).toHaveBeenCalledWith(expect.stringContaining("person 1"), expect.any(Error));
        errors.mockRestore();
    });
});

describe("openPersonAgreementOnEngage — taking part never fails on it", () => {
    it("logs a failure and returns null instead of throwing", async () => {
        jest.mocked(prisma.boardSettings.findUnique).mockResolvedValue({ orgMembershipYearBoundary: BOUNDARY } as never);
        jest.mocked(prisma.$transaction).mockRejectedValueOnce(new Error("lock timeout"));
        const errors = jest.spyOn(console, "error").mockImplementation(() => {});

        await expect(openPersonAgreementOnEngage(7, NOW)).resolves.toBeNull();

        expect(errors).toHaveBeenCalledWith(expect.stringContaining("person 7"), expect.any(Error));
        errors.mockRestore();
    });
});

describe("closePersonAgreementOnLead — a new lead signs the household agreement instead", () => {
    it("archives each open, unsigned agreement, with an audit row, and touches nothing signed", async () => {
        const tx = {
            orgMembershipProcess: {
                findMany: jest.fn().mockResolvedValue([{ id: 31 }]),
                updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            },
            auditLog: { create: jest.fn() },
        };

        await closePersonAgreementOnLead(tx as unknown as TxClient, 5);

        expect(tx.orgMembershipProcess.findMany.mock.calls[0][0].where).toMatchObject({ kind: "PERSON_AGREEMENT", subjectPersonId: 5, contractSignedAt: null, status: "PENDING_EXTERNAL_ACTION" });
        expect(tx.orgMembershipProcess.updateMany).toHaveBeenCalledWith({
            where: expect.objectContaining({ id: 31, contractSignedAt: null, status: "PENDING_EXTERNAL_ACTION" }),
            data: expect.objectContaining({ status: "ARCHIVED" }),
        });
        expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    });

    it("writes no audit row when the agreement was signed in the meantime", async () => {
        const tx = {
            orgMembershipProcess: { findMany: jest.fn().mockResolvedValue([{ id: 31 }]), updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
            auditLog: { create: jest.fn() },
        };

        await closePersonAgreementOnLead(tx as unknown as TxClient, 5);

        expect(tx.auditLog.create).not.toHaveBeenCalled();
    });
});

describe("runPersonAgreementSweep — the org zone's day", () => {
    afterEach(() => { mockOrgZone = "America/Chicago"; });

    it.each([
        ["America/New_York", "2025-09-01T00:00:00.000Z", "2027-09-01T00:00:00.000Z"],
        ["America/Chicago", "2024-09-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z"],
    ])("starts the new membership year as the day turns in %s", async (zone, previousStart, thisEnd) => {
        mockOrgZone = zone;
        jest.mocked(prisma.boardSettings.findUnique).mockResolvedValue({ orgMembershipYearBoundary: BOUNDARY } as never);
        const findMany = jest.mocked(prisma.person.findMany).mockResolvedValue([] as never);

        // 12:30 AM on 1 September in New York, 11:30 PM on 31 August in Chicago.
        await runPersonAgreementSweep(new Date("2026-09-01T04:30:00.000Z"));

        // The pass reads the previous membership year and the one in progress.
        const where = findMany.mock.calls.at(-1)![0]!.where as { OR: { programsLed?: { some: { startAt: { lt: Date }; endAt: { gte: Date } } } }[] };
        const led = where.OR.find((arm) => arm.programsLed)!.programsLed!;
        expect(led.some.endAt.gte.toISOString()).toBe(previousStart);
        expect(led.some.startAt.lt.toISOString()).toBe(thisEnd);
    });
});
