import prisma from "@/lib/prisma";
import { inAgreementAgeBand, hasKnownAdultAge, agreementCycleFloor, openPersonAgreement, runPersonAgreementSweep } from "@/lib/membership/personAgreementTriggers";
import { calendarDayIn } from "@/lib/time";

let mockOrgZone = "America/Chicago";
jest.mock("@/lib/appSettings", () => ({
    orgToday: async (now: Date) => jest.requireActual<typeof import("@/lib/time")>("@/lib/time").calendarDayIn(now, mockOrgZone),
}));

jest.mock("@/lib/prisma", () => ({
    __esModule: true,
    default: { $transaction: jest.fn(), boardSettings: { findUnique: jest.fn() }, person: { findMany: jest.fn() } },
}));

/**
 * The two pure rules behind PERSON_AGREEMENT: who the automatic pass picks, and
 * when a prior agreement stops covering the current cycle. Both are the parts that decide
 * whether a real person is asked to sign, so they're pinned here rather than left to the
 * DB-backed trigger test.
 */

const BOUNDARY = new Date("2000-09-01"); // anchor day-of-year; the year is irrelevant
const yearsAgo = (n: number, from = new Date("2026-08-02")) =>
    new Date(Date.UTC(from.getUTCFullYear() - n, from.getUTCMonth(), from.getUTCDate()));
// A real instant on 2 August, mid-morning in the org's zone, and the day it falls on.
const NOW = new Date("2026-08-02T15:00:00.000Z");
const TODAY = new Date("2026-08-02T00:00:00.000Z");

describe("inAgreementAgeBand — the automatic population", () => {
    const now = TODAY;

    it("takes 18 through 25 with a DOB on file", () => {
        expect(inAgreementAgeBand({ dateOfBirth: yearsAgo(18), isDeclaredAdult: false }, now)).toBe(true);
        expect(inAgreementAgeBand({ dateOfBirth: yearsAgo(22), isDeclaredAdult: false }, now)).toBe(true);
        expect(inAgreementAgeBand({ dateOfBirth: yearsAgo(25), isDeclaredAdult: false }, now)).toBe(true);
    });

    it("refuses a minor — the whole point is that a parent's signature stops binding at 18", () => {
        expect(inAgreementAgeBand({ dateOfBirth: yearsAgo(17), isDeclaredAdult: false }, now)).toBe(false);
        // One day short of 18.
        const almost = new Date(Date.UTC(2008, 7, 3));
        expect(inAgreementAgeBand({ dateOfBirth: almost, isDeclaredAdult: false }, now)).toBe(false);
    });

    it("opens on the 18th birthday as the org zone's day turns, not Chicago's", () => {
        // 12:30 AM on 2 August in New York, 11:30 PM on 1 August in Chicago.
        const instant = "2026-08-02T04:30:00.000Z";
        const eighteen = { dateOfBirth: yearsAgo(18), isDeclaredAdult: false };
        expect(inAgreementAgeBand(eighteen, calendarDayIn(instant, "America/New_York"))).toBe(true);
        expect(hasKnownAdultAge(eighteen, calendarDayIn(instant, "America/New_York"))).toBe(true);
        expect(inAgreementAgeBand(eighteen, calendarDayIn(instant, "America/Chicago"))).toBe(false);
        expect(hasKnownAdultAge(eighteen, calendarDayIn(instant, "America/Chicago"))).toBe(false);
    });

    it("refuses over 25 — a non-lead adult that old is a spouse, not an adult child", () => {
        expect(inAgreementAgeBand({ dateOfBirth: yearsAgo(26), isDeclaredAdult: false }, now)).toBe(false);
        // The ceiling is explicit, not inherited from the DOB purge: a 30-year-old
        // spouse added with a DOB is refused immediately, not merely by the next purge.
        expect(inAgreementAgeBand({ dateOfBirth: yearsAgo(30), isDeclaredAdult: false }, now)).toBe(false);
    });

    it("refuses an unknown age, declared-adult included (that flag MEANS over 25)", () => {
        expect(inAgreementAgeBand({ dateOfBirth: null, isDeclaredAdult: true }, now)).toBe(false);
        expect(inAgreementAgeBand({ dateOfBirth: null, isDeclaredAdult: false }, now)).toBe(false);
    });
});

describe("hasKnownAdultAge — the looser manual (board) rule", () => {
    const now = TODAY;

    it("accepts the over-25s the automatic band refuses — the board judges those itself", () => {
        expect(hasKnownAdultAge({ dateOfBirth: null, isDeclaredAdult: true }, now)).toBe(true);
        expect(hasKnownAdultAge({ dateOfBirth: yearsAgo(30), isDeclaredAdult: false }, now)).toBe(true);
    });

    it("still refuses a minor and an unknown age", () => {
        expect(hasKnownAdultAge({ dateOfBirth: yearsAgo(17), isDeclaredAdult: false }, now)).toBe(false);
        expect(hasKnownAdultAge({ dateOfBirth: null, isDeclaredAdult: false }, now)).toBe(false);
    });
});

describe("agreementCycleFloor — one agreement per cycle, no double-ask", () => {
    it("covers everything signed since the current cycle opened", () => {
        // Mid-cycle: boundary Sept 1, so the live cycle started 2025-09-01.
        const floor = agreementCycleFloor(BOUNDARY, new Date("2026-03-15"));
        expect(new Date("2026-01-10") >= floor).toBe(true); // signed in January — still covers
        expect(new Date("2025-03-01") >= floor).toBe(false); // last cycle — needs a fresh one
    });

    it("does not re-ask someone who signed during the run-up to the boundary", () => {
        // Sign Aug 20, boundary rolls Sept 1, and a floor
        // set AT the boundary would ask them again two weeks later. Backing the floor off
        // by the renewal lead window (as runRenewalSweep does) keeps them covered.
        const signedAt = new Date("2026-08-20");
        const before = agreementCycleFloor(BOUNDARY, new Date("2026-08-25"));
        const after = agreementCycleFloor(BOUNDARY, new Date("2026-09-02"));
        expect(signedAt >= before).toBe(true);
        expect(signedAt >= after).toBe(true);
    });

    it("does ask again a year later", () => {
        const signedAt = new Date("2026-08-20");
        const nextCycle = agreementCycleFloor(BOUNDARY, new Date("2027-09-02"));
        expect(signedAt >= nextCycle).toBe(false);
    });

    it("advances by exactly one year across a boundary", () => {
        const before = agreementCycleFloor(BOUNDARY, new Date("2026-08-25"));
        const after = agreementCycleFloor(BOUNDARY, new Date("2026-09-02"));
        expect(after.getUTCFullYear() - before.getUTCFullYear()).toBe(1);
        expect(after.getUTCMonth()).toBe(before.getUTCMonth());
        expect(after.getUTCDate()).toBe(before.getUTCDate());
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

describe("runPersonAgreementSweep — one person's failure", () => {
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

describe("runPersonAgreementSweep — the org zone's day", () => {
    afterEach(() => { mockOrgZone = "America/Chicago"; });

    it.each([
        ["America/New_York", "2026-10-12T00:00:00.000Z"],
        ["America/Chicago", "2026-10-11T00:00:00.000Z"],
    ])("bounds the program window by the day in %s", async (zone, day) => {
        mockOrgZone = zone;
        jest.mocked(prisma.boardSettings.findUnique).mockResolvedValue({ orgMembershipYearBoundary: BOUNDARY } as never);
        const findMany = jest.mocked(prisma.person.findMany).mockResolvedValue([] as never);

        // 12:30 AM on the 12th in New York, 11:30 PM on the 11th in Chicago.
        await runPersonAgreementSweep(new Date("2026-10-12T04:30:00.000Z"));

        const where = findMany.mock.calls.at(-1)![0]!.where as { OR: { programsLed?: { some: { AND: { startAt?: { lte: Date } }[] } } }[] };
        const led = where.OR.find((arm) => arm.programsLed)!.programsLed!;
        expect(led.some.AND[1].startAt!.lte.toISOString()).toBe(day);
    });
});
