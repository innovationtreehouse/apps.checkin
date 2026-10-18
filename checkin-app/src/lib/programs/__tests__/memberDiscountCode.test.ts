/**
 * @jest-environment node
 */
/**
 * Unit tests for the program member-discount-code helpers: the code-format
 * predicate and the money-event entitlement judgement both the orders/paid webhook
 * and the reconciler's forward pass call. The integration matrices drive them
 * through the real routes against a real DB; those suites are not in the default
 * jest run, so this pins the logic itself in default CI.
 */
jest.mock("@/lib/prisma", () => ({
    __esModule: true,
    default: {
        program: { findUnique: jest.fn() },
        programParticipant: { findMany: jest.fn() },
        boardSettings: { findUnique: jest.fn() },
    },
}));
jest.mock("@/lib/orgMembership", () => ({
    isMembershipFeeSettledThrough: jest.fn(),
    programCoverageDate: jest.requireActual("@/lib/orgMembership").programCoverageDate,
}));

import prisma from "@/lib/prisma";
import { isMembershipFeeSettledThrough } from "@/lib/orgMembership";
import { usesProgramMemberCode, unentitledMemberCodeUse, memberCodeHousehold } from "../memberDiscountCode";

const findUnique = prisma.program.findUnique as jest.Mock;
const participants = prisma.programParticipant.findMany as jest.Mock;
const settledThrough = isMembershipFeeSettledThrough as jest.Mock;

beforeEach(() => {
    jest.clearAllMocks();
    findUnique.mockResolvedValue({ startAt: new Date("2026-06-01"), endAt: new Date("2026-08-01") });
    // Default: every id asked about really is enrolled in the program. The
    // stuffed-id test below overrides this with the DB's narrower answer.
    participants.mockImplementation(({ where }: { where: { personId: { in: number[] } } }) =>
        Promise.resolve(where.personId.in.map((personId) => ({ personId, person: { householdId: 5 } }))),
    );
});

describe("usesProgramMemberCode", () => {
    it("flags a minted code for the given program", () => {
        expect(usesProgramMemberCode(["PRG42-ABCD1234"], 42)).toBe(true);
    });

    it("compares case-insensitively — Shopify codes are case-insensitive", () => {
        expect(usesProgramMemberCode(["prg42-abcd1234"], 42)).toBe(true);
    });

    it("tolerates surrounding whitespace", () => {
        expect(usesProgramMemberCode([" PRG42-ABCD1234 "], 42)).toBe(true);
    });

    it("ignores a code minted for a different program", () => {
        expect(usesProgramMemberCode(["PRG7-ABCD1234"], 42)).toBe(false);
    });

    it("the trailing hyphen guards against adjacent-id prefix collisions (PRG4 vs PRG42)", () => {
        // A bare `startsWith("PRG42")` would wrongly match "PRG420-..." / let
        // "PRG4-..." satisfy a "PRG42" prefix check via string concatenation.
        expect(usesProgramMemberCode(["PRG42-ABCD1234"], 4)).toBe(false);
        expect(usesProgramMemberCode(["PRG4-ABCD1234"], 42)).toBe(false);
    });

    it("ignores unrelated codes — promos are Shopify's business, not checkin's", () => {
        expect(usesProgramMemberCode(["SUMMER26"], 42)).toBe(false);
        expect(usesProgramMemberCode(["VOLFAM"], 42)).toBe(false);
    });

    it("an empty code list never flags (parity with usesVolunteerCodeUnentitled)", () => {
        expect(usesProgramMemberCode([], 42)).toBe(false);
    });
});

describe("unentitledMemberCodeUse", () => {
    it("judges a crossing program stated as the earlier year against that year's closing boundary", async () => {
        findUnique.mockImplementation(({ select }: { select: Record<string, boolean> }) =>
            Promise.resolve(select.appliesToYear
                ? { startAt: new Date("2027-06-01"), endAt: new Date("2027-10-01"), appliesToYear: 2026 }
                : { startAt: new Date("2027-06-01"), endAt: new Date("2027-10-01") }),
        );
        (prisma.boardSettings.findUnique as jest.Mock).mockResolvedValue({ orgMembershipYearBoundary: new Date(Date.UTC(2000, 8, 1)) });
        settledThrough.mockResolvedValue(true);
        expect(await unentitledMemberCodeUse(42, [1], ["PRG42-ABCD1234"], "ord-1")).toBe(false);
        expect(settledThrough).toHaveBeenCalledWith(1, new Date(Date.UTC(2027, 8, 1)));
    });

    it("flags when the order carries the program's code and no enrollee is fee-settled", async () => {
        settledThrough.mockResolvedValue(false);
        expect(await unentitledMemberCodeUse(42, [1, 2], ["PRG42-ABCD1234"], "ord-1")).toBe(true);
        expect(settledThrough).toHaveBeenCalledTimes(2);
    });

    it("does not flag when SOME enrollee's household is fee-settled through the coverage date", async () => {
        settledThrough.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
        expect(await unentitledMemberCodeUse(42, [1, 2], ["PRG42-ABCD1234"], "ord-1")).toBe(false);
    });

    it("asks entitlement against the program's coverage date (endAt), not today", async () => {
        settledThrough.mockResolvedValue(true);
        await unentitledMemberCodeUse(42, [1], ["PRG42-ABCD1234"], "ord-1");
        expect(settledThrough).toHaveBeenCalledWith(1, new Date("2026-08-01"));
    });

    it("still flags when a foreign fee-settled id is STUFFED into the cart permalink", async () => {
        // CheckMeIn_Account_ID is customer-controlled: a non-member enrolls (PENDING,
        // unpaid), then builds the permalink as `<own id>,<any settled person's id>`
        // (ids are autoincrement, so one is easy to guess). Only person 1 is enrolled
        // in this program, so person 99's household must not lend its entitlement —
        // activateProgramEnrollment ignores the stuffed id and would activate person 1.
        participants.mockResolvedValue([{ personId: 1 }]);
        settledThrough.mockImplementation(async (personId: number) => personId === 99);

        expect(await unentitledMemberCodeUse(42, [1, 99], ["PRG42-ABCD1234"], "ord-1")).toBe(true);
        expect(settledThrough).toHaveBeenCalledTimes(1);
        expect(settledThrough).toHaveBeenCalledWith(1, new Date("2026-08-01"));
    });

    it("flags when NO supplied id is enrolled in the program at all (empty intersection)", async () => {
        participants.mockResolvedValue([]);
        settledThrough.mockResolvedValue(true);
        expect(await unentitledMemberCodeUse(42, [99], ["PRG42-ABCD1234"], "ord-1")).toBe(true);
        expect(settledThrough).not.toHaveBeenCalled();
    });


    it("scopes the intersect to rows THIS order pays for — PENDING or stamped with this order id", async () => {
        // A fee-settled co-enrollee who is already ACTIVE via some OTHER order must
        // not lend entitlement (thpr's residual: guess an enrolled+settled id, ride
        // their status-blind row). The DB-side OR narrows to this order's own rows.
        settledThrough.mockResolvedValue(false);
        await unentitledMemberCodeUse(42, [1, 7], ["PRG42-ABCD1234"], "ord-1");
        expect(participants).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    OR: [{ status: "PENDING" }, { shopifyOrderId: "ord-1" }],
                }),
            }),
        );
    });

    it("a redelivered webhook still recognizes its own already-ACTIVE rows and stays quiet", async () => {
        // Redelivery: the honest order's rows are ACTIVE but stamped with this same
        // shopifyOrderId, so the OR's second arm matches them and entitlement holds.
        participants.mockResolvedValue([{ personId: 1 }]);
        settledThrough.mockResolvedValue(true);
        expect(await unentitledMemberCodeUse(42, [1], ["PRG42-ABCD1234"], "ord-1")).toBe(false);
    });

    it("with no order id the intersect keeps only the PENDING arm", async () => {
        settledThrough.mockResolvedValue(false);
        await unentitledMemberCodeUse(42, [1], ["PRG42-ABCD1234"], null);
        expect(participants).toHaveBeenCalledWith(
            expect.objectContaining({ where: expect.objectContaining({ OR: [{ status: "PENDING" }] }) }),
        );
    });

    it("never judges an order that does not carry this program's code — no entitlement query at all", async () => {
        settledThrough.mockResolvedValue(false);
        expect(await unentitledMemberCodeUse(42, [1], [], "ord-1")).toBe(false);
        expect(await unentitledMemberCodeUse(42, [1], ["SUMMER26"], "ord-1")).toBe(false);
        expect(await unentitledMemberCodeUse(42, [1], ["PRG7-ABCD1234"], "ord-1")).toBe(false);
        expect(settledThrough).not.toHaveBeenCalled();
        expect(findUnique).not.toHaveBeenCalled();
        expect(participants).not.toHaveBeenCalled();
    });

    it("a program with no dates asks the status-only question (through = null)", async () => {
        findUnique.mockResolvedValue({ startAt: null, endAt: null });
        settledThrough.mockResolvedValue(false);
        expect(await unentitledMemberCodeUse(42, [1], ["PRG42-ABCD1234"], "ord-1")).toBe(true);
        expect(settledThrough).toHaveBeenCalledWith(1, null);
    });
});

describe("memberCodeHousehold", () => {
    it("reads the household a code was minted for", () => {
        expect(memberCodeHousehold(["PRG42-H5-ABCD1234"], 42)).toBe(5);
        expect(memberCodeHousehold([" prg42-h5-abcd1234 "], 42)).toBe(5);
    });

    it("is null for an unbound code, another program's code, or no code", () => {
        expect(memberCodeHousehold(["PRG42-ABCD1234"], 42)).toBeNull();
        expect(memberCodeHousehold(["PRG4-H5-ABCD1234"], 42)).toBeNull();
        expect(memberCodeHousehold([], 42)).toBeNull();
    });
});

describe("unentitledMemberCodeUse with a household-bound code", () => {
    it("does not flag the household it was minted for, settled through the program", async () => {
        settledThrough.mockResolvedValue(true);
        expect(await unentitledMemberCodeUse(42, [1, 2], ["PRG42-H5-ABCD1234"], "ord-1")).toBe(false);
        expect(settledThrough).toHaveBeenCalledWith(1, new Date("2026-08-01"));
    });

    it("flags a code used on another household's children", async () => {
        settledThrough.mockResolvedValue(true);
        expect(await unentitledMemberCodeUse(42, [1], ["PRG42-H6-ABCD1234"], "ord-1")).toBe(true);
        expect(settledThrough).not.toHaveBeenCalled();
    });

    it("flags when one enrollee is outside the code's household", async () => {
        participants.mockResolvedValue([
            { personId: 1, person: { householdId: 5 } },
            { personId: 2, person: { householdId: 6 } },
        ]);
        settledThrough.mockResolvedValue(true);
        expect(await unentitledMemberCodeUse(42, [1, 2], ["PRG42-H5-ABCD1234"], "ord-1")).toBe(true);
    });

    it("flags the right household once its membership fee no longer covers the program", async () => {
        settledThrough.mockResolvedValue(false);
        expect(await unentitledMemberCodeUse(42, [1], ["PRG42-H5-ABCD1234"], "ord-1")).toBe(true);
    });

    it("flags when nobody named is enrolled", async () => {
        participants.mockResolvedValue([]);
        settledThrough.mockResolvedValue(true);
        expect(await unentitledMemberCodeUse(42, [1], ["PRG42-H5-ABCD1234"], "ord-1")).toBe(true);
    });
});
