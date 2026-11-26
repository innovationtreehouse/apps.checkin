/**
 * The supervising-adult test — the shared rule behind the
 * departure interrupt and the two-deep compliance banner. Policy's "two deep" is
 * two unrelated cleared volunteers, so every edge here is a way a
 * count-bare-adults check would report a room compliant when it is not.
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

import { supervisingAdultCount, supervisingAdultVisits, uncoveredYouth } from "@/lib/supervision";
import { APP_TIMEZONE, calendarDayIn } from "@/lib/time";
import prismaDb from "@/lib/prisma";

const today = calendarDayIn(new Date(), APP_TIMEZONE);

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
    // A recheck policy long enough that the default year-old check stays valid.
    boardSettingsFindUnique.mockResolvedValue({ orgMembershipYearBoundary: new Date(Date.UTC(2000, 7, 1)), bgRecheckMonths: 24 });
});

async function count(rows: ReturnType<typeof visit>[], day: Date = today) {
    findMany.mockResolvedValue(rows);
    return supervisingAdultCount(await supervisingAdultVisits(prismaDb, day));
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

    it("excludes an unknown age but keeps a DoB-stripped declared adult", async () => {
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

    it("excludes an adult holding a participant seat on a programme meeting now", async () => {
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

    it("counts no one while the board has set no recheck policy", async () => {
        boardSettingsFindUnique.mockResolvedValue({ ...settings, bgRecheckMonths: 0 });
        expect(await count([visit(1, 10), visit(2, 20)])).toBe(0);
    });

    it("counts no one when there is no settings row", async () => {
        boardSettingsFindUnique.mockResolvedValue(null);
        expect(await count([visit(1, 10), visit(2, 20)])).toBe(0);
    });

    it("counts no one while no membership-year boundary is set", async () => {
        boardSettingsFindUnique.mockResolvedValue({ ...settings, orgMembershipYearBoundary: null });
        expect(await count([visit(1, 10), visit(2, 20)])).toBe(0);
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

describe("the org's calendar day", () => {
    // 12:30 AM on the 12th in New York, 11:30 PM on the 11th in Chicago.
    const instant = "2026-10-12T04:30:00.000Z";
    const newYork = calendarDayIn(instant, "America/New_York");
    const chicago = calendarDayIn(instant, "America/Chicago");

    it("judges a clearance that runs out on the 11th against the org's day", async () => {
        // Boundary Oct 11, recheck every 12 months: a check on 2025-10-11 is valid through 2026-10-11.
        boardSettingsFindUnique.mockResolvedValue({ orgMembershipYearBoundary: new Date(Date.UTC(2000, 9, 11)), bgRecheckMonths: 12 });
        const rows = [visit(1, 10), visit(2, 20, { lastBackgroundCheck: new Date("2025-10-11T15:00:00Z") })];
        expect(await count(rows, chicago)).toBe(2);
        expect(await count(rows, newYork)).toBe(1);
    });

    it("counts an 18th birthday from the org's midnight", async () => {
        const rows = [visit(1, 10), visit(2, 20, { dateOfBirth: new Date("2008-10-12T00:00:00.000Z") })];
        expect(await count(rows, newYork)).toBe(2);
        expect(await count(rows, chicago)).toBe(1);
    });
});

describe("the programme-meeting probe", () => {
    it("excludes a participant only while a meeting of their programme brackets now", async () => {
        const now = new Date("2026-08-18T15:00:00Z");
        findMany.mockResolvedValue([]);
        await supervisingAdultVisits(prismaDb, today, now);

        const where = findMany.mock.calls[0][0].select.person.select.programParticipants.where;
        expect(where).toEqual({
            status: "ACTIVE",
            program: { events: { some: { startAt: { lte: now }, endAt: { gte: now } } } },
        });
    });
});

describe("uncoveredYouth", () => {
    const youth = (householdId: number) => ({ youth: true, householdId });
    const adult = (householdId: number) => ({ youth: false, householdId });

    it("covers a youth with an adult of their own household present", () => {
        expect(uncoveredYouth([youth(10), adult(10)])).toEqual([]);
    });

    it("leaves a youth uncovered when only other households' adults are present", () => {
        expect(uncoveredYouth([youth(10), adult(20)])).toEqual([youth(10)]);
    });

    it("sorts a mix of covered and uncovered youth", () => {
        expect(uncoveredYouth([youth(10), youth(30), adult(10), adult(20)])).toEqual([youth(30)]);
    });

    it("does not let a youth cover a sibling", () => {
        expect(uncoveredYouth([youth(10), youth(10)])).toHaveLength(2);
    });
});
