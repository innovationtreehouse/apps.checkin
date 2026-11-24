import prisma from "@/lib/prisma";
import type { TxClient } from "@/lib/db-client";
import { closePersonAgreementOnLead, membershipYearAt, openPersonAgreement, openPersonAgreementOnEngage, previousMembershipYear, runPersonAgreementSweep } from "@/lib/membership/personAgreementTriggers";

jest.mock("@/lib/prisma", () => ({
    __esModule: true,
    default: { $transaction: jest.fn(), boardSettings: { findUnique: jest.fn() }, person: { findMany: jest.fn() } },
}));

/**
 * The pure year arithmetic behind PERSON_AGREEMENT, and the failure handling of the
 * yearly pass and the open on taking part. Who is picked is pinned by the DB-backed test.
 */

const BOUNDARY = new Date("2000-09-01"); // anchor day-of-year; the year is irrelevant
// A real instant on 2 August, mid-morning in the org's zone — the year rule takes an
// instant and resolves it to the day it falls on there.
const NOW = new Date("2026-08-02T15:00:00.000Z");

describe("membershipYearAt — the year a new agreement is counted from", () => {
    it("starts at the latest boundary on or before today", () => {
        expect(membershipYearAt(BOUNDARY, NOW)).toEqual({ start: new Date("2025-09-01"), end: new Date("2026-09-01") });
        expect(membershipYearAt(BOUNDARY, new Date("2026-09-01T16:00:00.000Z"))).toEqual({ start: new Date("2026-09-01"), end: new Date("2027-09-01") });
    });

    it("does not move early for the renewal window", () => {
        // Two weeks before the boundary, renewals are open, but the year in progress is still the old one.
        expect(membershipYearAt(BOUNDARY, new Date("2026-08-18T16:00:00.000Z")).start).toEqual(new Date("2025-09-01"));
    });

    it("turns over at local midnight on the boundary, not UTC midnight", () => {
        // 9 PM on 31 August in the org's zone — UTC is already on 1 September.
        expect(membershipYearAt(BOUNDARY, new Date("2026-09-01T02:00:00.000Z")).start).toEqual(new Date("2025-09-01"));
    });

    it("the previous year ends where this one starts", () => {
        const year = membershipYearAt(BOUNDARY, NOW);
        expect(previousMembershipYear(year)).toEqual({ start: new Date("2024-09-01"), end: year.start });
    });
});

describe("openPersonAgreement — the per-person transaction", () => {
    it("runs with the explicit 15-second timeout", async () => {
        const transaction = jest.mocked(prisma.$transaction);
        transaction.mockResolvedValue(null as never);

        await openPersonAgreement(1, NOW, NOW);

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
