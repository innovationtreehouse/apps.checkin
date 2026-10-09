/**
 * The kiosk is an unattended device that re-broadcasts this payload into an iframe
 * with a wildcard postMessage origin (client/client.py), so its roster must carry no
 * `personal`/`pii` field. The privileged (keyholder/board/sysadmin) roster keeps them
 * — that grant is deliberate (registry.ts `keyholders:personal`, pickup/emergency).
 */
const findMany = jest.fn();
// The keyholder-cover query is the one that selects bare times.
const coverFindMany = jest.fn();
jest.mock("@/lib/prisma", () => ({ __esModule: true, default: {
    visit: {
        findMany: (args: { select?: unknown }) => (args.select ? coverFindMany(args) : findMany(args)),
    },
} }));

// Who counts as a supervising adult is lib/supervision's rule and is tested there
// (#1436/#1550). Pinned at 1 — short of two-deep — so what this file asserts is its
// OWN half: whether a youth is accompanied by an adult of their household.
const supervisingAdultVisits = jest.fn().mockResolvedValue(new Map());
jest.mock("@/lib/supervision", () => ({
    __esModule: true,
    MIN_SUPERVISING_ADULTS: 2,
    supervisingAdultVisits: (...a: unknown[]) => supervisingAdultVisits(...a),
    supervisingAdultCount: () => 1,
}));

import {
    NO_KEYHOLDER_GRACE_MS,
    getFullAttendance,
    invalidateAttendanceCache,
    visitHadNoKeyholder,
} from "@/lib/getFullAttendance";

// Age fixtures are relative to now so they never age past the youth boundary the
// way a hardcoded year would; the day step keeps the age unambiguous mid-year.
const yearsAgo = (n: number) => {
    const d = new Date();
    d.setFullYear(d.getFullYear() - n);
    d.setDate(d.getDate() - 1);
    return d;
};

const rows = [
    {
        id: 201, arrivedAt: new Date("2026-07-01T14:00:00Z"), departedAt: null, personId: 50,
        person: {
            id: 50, email: "karen@example.com", name: "Karen Keyholder", nickname: "Kay", isKeyholder: true,
            dateOfBirth: new Date("1985-01-01"), householdId: 6, phone: "5551234567",
            household: { id: 6, emergencyContacts: [{ id: 1, name: "Con One", phone: "5559990001", relationship: "Aunt" }] },
        },
        event: { id: 9, program: { id: 3, name: "Robotics", price: 100 } },
    },
    {
        id: 203, arrivedAt: new Date("2026-07-01T14:10:00Z"), departedAt: null, personId: 70,
        person: {
            id: 70, email: "stu@example.com", name: null, isKeyholder: false,
            dateOfBirth: yearsAgo(10), householdId: 8, phone: "5557654321",
            household: { id: 8, emergencyContacts: [{ id: 2, name: "Con Two", phone: "5559990002", relationship: null }] },
        },
        event: null,
    },
];

beforeEach(() => {
    invalidateAttendanceCache();
    findMany.mockReset();
    findMany.mockResolvedValue(rows);
    coverFindMany.mockReset();
    coverFindMany.mockResolvedValue([{ arrivedAt: rows[0].arrivedAt, departedAt: null }]);
    supervisingAdultVisits.mockClear();
});

describe("getFullAttendance({ kiosk: true })", () => {
    it("ships no dateOfBirth, phone, householdId or emergency contacts", async () => {
        const { attendance } = await getFullAttendance({ kiosk: true });

        const wire = JSON.stringify(attendance);
        expect(wire).not.toMatch(/dateOfBirth|phone|emergencyContacts|householdId/);
        // The contact values themselves, not just the keys.
        expect(wire).not.toContain("5551234567");
        expect(wire).not.toContain("Con One");

        expect(attendance[0]).toEqual({
            id: 201,
            arrivedAt: rows[0].arrivedAt,
            noKeyholder: false,
            participant: { id: 50, name: "Kay", isKeyholder: true, isYouth: false },
            event: { program: { id: 3, name: "Robotics" } },
        });
    });

    it("ships the kiosk label, never a last name — initial only to tell two apart", async () => {
        const kid = (id: number, name: string) => ({
            id, arrivedAt: rows[0].arrivedAt, departedAt: null, personId: id, event: null,
            person: { id, email: null, name, nickname: null, isKeyholder: false, dateOfBirth: yearsAgo(12), householdId: null, phone: null },
        });
        findMany.mockResolvedValue([kid(1, "Sam Lee"), kid(2, "Sam Park"), kid(3, "Jordan Quinlan")]);
        const { attendance } = await getFullAttendance({ kiosk: true });

        expect(attendance.map(v => v.participant.name)).toEqual(["Sam L.", "Sam P.", "Jordan"]);
        expect(JSON.stringify(attendance)).not.toMatch(/Lee|Park|Quinlan/);
    });

    it("still gives the display what it renders: name fallback, youth split, program badge", async () => {
        const { attendance, counts, safety } = await getFullAttendance({ kiosk: true });

        // name-or-email-prefix resolved server-side; raw address never ships
        expect(attendance[1].participant.name).toBe("stu");
        // the nickname is folded into the label server-side
        expect(attendance[0].participant.name).toBe("Kay");
        expect(JSON.stringify(attendance)).not.toContain("@example.com");
        // youth column still populates without dateOfBirth
        expect(attendance[1].participant.isYouth).toBe(true);
        expect(attendance[0].event).toEqual({ program: { id: 3, name: "Robotics" } });
        expect(attendance[1].event).toBeNull();
        // aggregates are identical either way
        expect(counts).toEqual({ keyholders: 1, volunteers: 0, youth: 1, total: 2 });
        expect(safety).toEqual({ facilityOpen: true, isLastKeyholder: true, isTwoDeepViolation: true });
    });

    it("does not even fetch the emergency contacts", async () => {
        await getFullAttendance({ kiosk: true });
        expect(findMany.mock.calls[0][0].include.person.select.household).toBe(false);
    });
});

describe("getFullAttendance() — privileged caller (unchanged)", () => {
    it("keeps dateOfBirth, phone and the household emergency contacts", async () => {
        const { attendance } = await getFullAttendance();

        expect(attendance[0].participant).toMatchObject({
            id: 50,
            name: "Karen Keyholder",
            nickname: "Kay",
            isKeyholder: true,
            dateOfBirth: rows[0].person.dateOfBirth,
            householdId: 6,
            phone: "5551234567",
            household: { id: 6, emergencyContacts: [{ id: 1, name: "Con One", phone: "5559990001", relationship: "Aunt" }] },
        });
        expect(findMany.mock.calls[0][0].include.person.select.household).toMatchObject({ select: { id: true } });
    });

    it("never ships the raw email on either path", async () => {
        const { attendance } = await getFullAttendance();
        expect(JSON.stringify(attendance)).not.toContain("@example.com");
    });
});

describe("visitHadNoKeyholder", () => {
    const at = new Date("2026-07-01T09:00:00Z");
    const plus = (ms: number) => new Date(at.getTime() + ms);

    it("is false when a keyholder was already present", () => {
        expect(visitHadNoKeyholder(at, [{ arrivedAt: plus(-60_000), departedAt: null }])).toBe(false);
    });

    it("is cleared by a keyholder arriving within the grace window", () => {
        expect(visitHadNoKeyholder(at, [{ arrivedAt: plus(NO_KEYHOLDER_GRACE_MS), departedAt: null }])).toBe(false);
    });

    it("stays when the keyholder arrives after the grace window", () => {
        expect(visitHadNoKeyholder(at, [{ arrivedAt: plus(NO_KEYHOLDER_GRACE_MS + 1), departedAt: null }])).toBe(true);
    });

    it("stays when the only keyholder had already left", () => {
        expect(visitHadNoKeyholder(at, [{ arrivedAt: plus(-3_600_000), departedAt: plus(-1) }])).toBe(true);
    });
});

describe("no-keyholder visits", () => {
    const loneVolunteer = { ...rows[1], person: { ...rows[1].person, dateOfBirth: yearsAgo(40) } };

    it("marks a visit with no keyholder cover and reports the facility closed", async () => {
        findMany.mockResolvedValue([loneVolunteer]);
        coverFindMany.mockResolvedValue([]);
        for (const kiosk of [false, true]) {
            invalidateAttendanceCache();
            const { attendance, counts, safety } = await getFullAttendance({ kiosk });
            expect(attendance[0].noKeyholder).toBe(true);
            // Present and counted — the kiosk shows them — but the building is not open.
            expect(counts.total).toBe(1);
            expect(safety.facilityOpen).toBe(false);
        }
    });

    it("never marks a keyholder, and skips the cover query when only keyholders are in", async () => {
        findMany.mockResolvedValue([rows[0]]);
        const { attendance, safety } = await getFullAttendance();
        expect(attendance[0].noKeyholder).toBe(false);
        expect(safety.facilityOpen).toBe(true);
        expect(coverFindMany).not.toHaveBeenCalled();
    });

    it("asks only for live keyholder visits that could cover the arrivals", async () => {
        await getFullAttendance();
        expect(coverFindMany.mock.calls[0][0].where).toMatchObject({
            deletedAt: null,
            person: { isKeyholder: true, mergedIntoId: null },
            arrivedAt: { lte: new Date(rows[1].arrivedAt.getTime() + NO_KEYHOLDER_GRACE_MS) },
            OR: [{ departedAt: null }, { departedAt: { gte: rows[1].arrivedAt } }],
        });
    });
});

describe("two-deep calc fails closed on unknown DOB (#300)", () => {
    // Youth (hh 8) + real adult (hh 6) + null-DOB visitor in the youth's
    // household. Under the old null→adult default the null-DOB visitor
    // "accompanied" the youth, masking the violation. The supervising-adult
    // count is the other prong and lives in lib/supervision now.
    const nullDobRow = {
        id: 204, arrivedAt: new Date("2026-07-01T14:20:00Z"), departedAt: null, personId: 80,
        person: {
            id: 80, email: "nodob@example.com", name: "No Dob", isKeyholder: false,
            dateOfBirth: null, isDeclaredAdult: false, householdId: 8, phone: null,
            household: { id: 8, emergencyContacts: [] },
        },
        event: null,
    };

    it("unknown DOB is never a supervising adult and cannot mask a violation", async () => {
        findMany.mockResolvedValue([...rows, nullDobRow]);
        const { attendance, counts, safety } = await getFullAttendance({ kiosk: true });

        expect(safety.isTwoDeepViolation).toBe(true);
        // counted as youth, not volunteer, and flagged as youth on the wire
        expect(counts).toEqual({ keyholders: 1, volunteers: 0, youth: 2, total: 3 });
        expect(attendance[2].participant.isYouth).toBe(true);
        expect(supervisingAdultVisits).toHaveBeenCalled();
    });

    it("a DoB-stripped declared adult (#1165) still accompanies their own youth", async () => {
        // Same shape, but the null-DoB visitor is a 26+ member whose DoB was
        // deliberately deleted: isDeclaredAdult wins over the fail-closed default,
        // so the youth of household 8 is no longer unaccompanied.
        findMany.mockResolvedValue([...rows, {
            ...nullDobRow,
            person: { ...nullDobRow.person, isDeclaredAdult: true },
        }]);
        const { attendance, counts, safety } = await getFullAttendance({ kiosk: true });

        expect(safety.isTwoDeepViolation).toBe(false);
        expect(counts).toEqual({ keyholders: 1, volunteers: 1, youth: 1, total: 3 });
        expect(attendance[2].participant.isYouth).toBe(false);
        // No unaccompanied youth, so the flag is false either way — the poll must
        // not pay for the supervision queries to learn that.
        expect(supervisingAdultVisits).not.toHaveBeenCalled();
    });
});

describe("attendance cache", () => {
    it("hits the DB once per shape until a write invalidates", async () => {
        await getFullAttendance({ kiosk: true });
        await getFullAttendance({ kiosk: true });
        expect(findMany).toHaveBeenCalledTimes(1);

        await getFullAttendance();
        await getFullAttendance();
        expect(findMany).toHaveBeenCalledTimes(2);

        invalidateAttendanceCache();
        await getFullAttendance({ kiosk: true });
        expect(findMany).toHaveBeenCalledTimes(3);
    });

    it("does not store a result an invalidate raced past", async () => {
        let release!: (v: unknown) => void;
        findMany.mockImplementationOnce(() => new Promise((r) => { release = r; }));
        const inFlight = getFullAttendance({ kiosk: true });
        await Promise.resolve();
        invalidateAttendanceCache();
        release(rows);
        await inFlight;

        // The pre-invalidate result was returned but not cached.
        findMany.mockResolvedValue([]);
        const fresh = await getFullAttendance({ kiosk: true });
        expect(fresh.counts.total).toBe(0);
        expect(findMany).toHaveBeenCalledTimes(2);
    });

    describe("staleness bound", () => {
        const fakeClock = (now: string) => jest.useFakeTimers({ now: new Date(now), doNotFake: ["nextTick", "setImmediate", "queueMicrotask"] });
        afterEach(() => jest.useRealTimers());

        it("refills after 60s while the building is occupied", async () => {
            fakeClock("2026-10-05T12:00:00Z");
            await getFullAttendance({ kiosk: true });
            jest.setSystemTime(new Date("2026-10-05T12:01:01Z"));
            await getFullAttendance({ kiosk: true });
            expect(findMany).toHaveBeenCalledTimes(2);
        });

        it("never expires an empty building, so the database can pause", async () => {
            findMany.mockResolvedValue([]);
            fakeClock("2026-10-05T12:00:00Z");
            await getFullAttendance({ kiosk: true });
            jest.setSystemTime(new Date("2026-10-05T18:00:00Z"));
            await getFullAttendance({ kiosk: true });
            expect(findMany).toHaveBeenCalledTimes(1);
        });
    });
});

