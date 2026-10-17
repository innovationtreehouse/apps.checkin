/**
 * The supervising-adult test (#1436 / #1550) — the shared rule behind the
 * departure interrupt and the two-deep compliance banner. Policy's "two deep" is
 * two unrelated cleared volunteers, so every edge here is a way the old
 * count-bare-adults check reported a room compliant when it was not.
 */
const findMany = jest.fn();
const boardSettingsFindUnique = jest.fn();
jest.mock("@/lib/prisma", () => ({
    __esModule: true,
    default: {
        visit: { findMany: (...a: unknown[]) => findMany(...a) },
        boardSettings: { findUnique: (...a: unknown[]) => boardSettingsFindUnique(...a) },
    },
}));

import { supervisingAdultCount, supervisingAdultVisits } from "@/lib/supervision";

const yearsAgo = (n: number) => {
    const d = new Date();
    d.setFullYear(d.getFullYear() - n);
    d.setDate(d.getDate() - 1);
    return d;
};

/** An open visit by a person who qualifies on every prong; override to break one. */
function visit(id: number, householdId: number, person: Record<string, unknown> = {}) {
    return {
        id,
        person: {
            householdId,
            dateOfBirth: yearsAgo(40),
            isDeclaredAdult: false,
            lastBackgroundCheck: yearsAgo(1),
            household: { orgMembership: { status: "ACTIVE" } },
            programParticipants: [],
            ...person,
        },
    };
}

beforeEach(() => {
    findMany.mockReset();
    boardSettingsFindUnique.mockReset();
    // No recheck policy configured — the default. Clearance never expires, but a
    // person still needs one on file.
    boardSettingsFindUnique.mockResolvedValue({ orgMembershipYearBoundary: null, bgRecheckMonths: 0 });
});

async function count(rows: ReturnType<typeof visit>[]) {
    findMany.mockResolvedValue(rows);
    return supervisingAdultCount(await supervisingAdultVisits());
}

describe("who counts as a supervising adult", () => {
    it("counts a cleared adult of an ACTIVE member household", async () => {
        expect(await count([visit(1, 10), visit(2, 20)])).toBe(2);
    });

    it("counts two adults of ONE household as one adult", async () => {
        expect(await count([visit(1, 10), visit(2, 10), visit(3, 20)])).toBe(2);
    });

    it("excludes a youth", async () => {
        expect(await count([visit(1, 10), visit(2, 20, { dateOfBirth: yearsAgo(15) })])).toBe(1);
    });

    it("excludes an unknown age but keeps a DoB-stripped declared adult (#1165, #300)", async () => {
        const unknown = visit(1, 10, { dateOfBirth: null });
        const declared = visit(2, 20, { dateOfBirth: null, isDeclaredAdult: true });
        expect(await count([unknown, declared])).toBe(1);
    });

    it("excludes an adult whose household is not an ACTIVE member — ACTIVE encodes cleared", async () => {
        const revoked = visit(2, 20, { household: { orgMembership: { status: "REVOKED" } } });
        const noMembership = visit(3, 30, { household: { orgMembership: null } });
        expect(await count([visit(1, 10), revoked, noMembership])).toBe(1);
    });

    it("excludes an adult with no background check on file", async () => {
        expect(await count([visit(1, 10), visit(2, 20, { lastBackgroundCheck: null })])).toBe(1);
    });

    it("excludes an adult holding a participant seat on a programme in session now", async () => {
        const participant = visit(2, 20, { programParticipants: [{ programId: 7 }] });
        expect(await count([visit(1, 10), participant])).toBe(1);
    });
});

describe("clearance validity", () => {
    // Boundary Aug 1, recheck every 12 months: a check expires at the boundary
    // following lastBackgroundCheck + 12 months.
    const settings = { orgMembershipYearBoundary: new Date(Date.UTC(2000, 7, 1)), bgRecheckMonths: 12 };

    it("excludes an adult whose clearance has expired under the board's recheck policy", async () => {
        boardSettingsFindUnique.mockResolvedValue(settings);
        expect(await count([visit(1, 10), visit(2, 20, { lastBackgroundCheck: yearsAgo(5) })])).toBe(1);
    });

    it("keeps an adult whose clearance is inside the recheck window", async () => {
        boardSettingsFindUnique.mockResolvedValue(settings);
        expect(await count([visit(1, 10), visit(2, 20)])).toBe(2);
    });
});

describe("supervisingAdultCount(excludeVisitId)", () => {
    const supervising = new Map([[1, 10], [2, 10], [3, 20]]);

    it("answers as if that visit had already departed", () => {
        expect(supervisingAdultCount(supervising)).toBe(2);
        expect(supervisingAdultCount(supervising, 3)).toBe(1);
    });

    it("does not drop the count when the household is still represented", () => {
        expect(supervisingAdultCount(supervising, 1)).toBe(2);
    });
});

describe("the programme-in-session probe", () => {
    it("asks for an event bracketing now, dates covering today, or a RUNNING programme", async () => {
        const now = new Date("2026-08-18T15:00:00Z");
        findMany.mockResolvedValue([]);
        await supervisingAdultVisits(undefined, now);

        const where = findMany.mock.calls[0][0].select.person.select.programParticipants.where;
        expect(where.status).toBe("ACTIVE");
        expect(where.program.OR).toEqual([
            { events: { some: { startAt: { lte: now }, endAt: { gte: now } } } },
            { startAt: { lte: expect.any(Date) }, endAt: { gte: expect.any(Date) } },
            { phase: "RUNNING", startAt: { lte: expect.any(Date) } },
        ]);
    });
});
