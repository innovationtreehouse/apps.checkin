/**
 * The departure interrupt ladder. Drives the REAL supervising-adult test
 * through processCheckout, so the two stay wired together:
 *
 *   third supervising adult leaves (two remain) → warning, checkout proceeds
 *   next one leaves, a youth is here            → warning AND badge-again confirm
 *   next one leaves, no youth is here           → warning, checkout proceeds
 *   anyone else leaves their own youth short    → badge-again confirm
 *
 * The keyholder close-guard is a separate interrupt with its own stamp; the
 * participant here is not a keyholder, so only the supervision rungs run.
 */
import type { Person } from "@/generated/prisma/client";
import type { DbClient } from "@/lib/db-client";
import { processVisitCheckout } from "@/lib/attendanceTransitions";
import { processCheckin, processCheckout, type ScanOutcome } from "@/lib/attendance/scan";
import { toResponse } from "@/app/api/scan/scanResponse";

/** A scan service's outcome as the kiosk receives it. */
const wire = async (outcome: Promise<ScanOutcome>) => toResponse(await outcome, { signedRequest: true });


jest.mock("@/lib/prisma", () => ({ __esModule: true, default: {} }));
jest.mock("@/lib/notifications", () => ({
    sendCheckinNotifications: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("@/lib/attendanceTransitions", () => ({
    findAssociatedEventAt: jest.fn().mockResolvedValue(null),
    processVisitCheckout: jest.fn().mockResolvedValue([]),
}));

const adult = { id: 1, isKeyholder: false, isDeclaredAdult: true, dateOfBirth: null } as Person;
const youth = { id: 9, isKeyholder: false, isDeclaredAdult: false, dateOfBirth: new Date("2015-01-01") } as Person;

const ARRIVING_VISIT = 500;
const YOUTH_DOB = new Date("2015-01-01");
/** A household no adult in these tests belongs to. */
const LONE_HOUSEHOLD = 999;

const DEPARTING_VISIT = 42;

/** One open visit per household id, all fully qualifying supervising adults. */
function openVisits(householdIds: number[]) {
    return householdIds.map((householdId, i) => ({
        id: i === 0 ? DEPARTING_VISIT : 100 + i,
        person: {
            householdId,
            dateOfBirth: null,
            isDeclaredAdult: true,
            lastBackgroundCheck: new Date("2026-01-01"),
            household: { orgMembership: { status: "ACTIVE" } },
            programParticipants: [],
        },
    }));
}

/** A youth's open visit; `id` {@link ARRIVING_VISIT} is the check-in under test. */
const youthVisit = (id: number, householdId: number) =>
    ({ id, person: { householdId, isDeclaredAdult: false, dateOfBirth: YOUTH_DOB } });

/** The supervising-adult query and the youth probe both hit `visit.findMany`;
 *  the supervising query is the one selecting `lastBackgroundCheck`. One youth
 *  no adult covers is present by default — the confirm rung is gated on it. */
function fakeDb(
    householdIds: number[],
    warnedAt: Date | null = null,
    youthPresent = true,
    youthRows: ReturnType<typeof youthVisit>[] = youthPresent ? [youthVisit(ARRIVING_VISIT, LONE_HOUSEHOLD)] : [],
) {
    const update = jest.fn().mockResolvedValue({});
    const db = {
        // The facility advisory lock is a no-op against a fake client.
        $executeRaw: jest.fn().mockResolvedValue(0),
        boardSettings: { findUnique: jest.fn().mockResolvedValue({ orgMembershipYearBoundary: new Date(Date.UTC(2000, 7, 1)), bgRecheckMonths: 120 }) },
        visit: {
            findFirst: jest.fn().mockResolvedValue(null),
            count: jest.fn().mockResolvedValue(1),
            findMany: jest.fn().mockImplementation(({ select }) =>
                select.person.select.lastBackgroundCheck
                    ? openVisits(householdIds)
                    : [...openVisits(householdIds), ...youthRows]),
            findUnique: jest.fn().mockResolvedValue({ supervisionWarnedAt: warnedAt }),
            create: jest.fn().mockResolvedValue({ id: 500 }),
            update,
        },
    };
    return { db: db as unknown as DbClient, update };
}

async function checkout(
    householdIds: number[],
    warnedAt: Date | null = null,
    youthPresent = true,
    youthRows?: ReturnType<typeof youthVisit>[],
) {
    const { db, update } = fakeDb(householdIds, warnedAt, youthPresent, youthRows);
    const res = await wire(processCheckout(adult, DEPARTING_VISIT, db));
    return { res, body: await res.json(), update, db };
}

describe("rung 1 — the third supervising adult leaves", () => {
    it("warns on the successful checkout and does not ask for a confirm", async () => {
        const { res, body, update } = await checkout([10, 20, 30]);

        expect(res.status).toBe(200);
        expect(body.type).toBe("checkout");
        expect(body.warning).toMatch(/only 2 supervising adults remain/i);
        expect(update).not.toHaveBeenCalled();
    });

    it("stays quiet while more than two would remain", async () => {
        const { body } = await checkout([10, 20, 30, 40]);
        expect(body.warning).toBeUndefined();
    });
});

describe("rung 2 — the next supervising adult leaves", () => {
    it("blocks with a warning and stamps the visit", async () => {
        const { res, body, update } = await checkout([10, 20]);

        expect(res.status).toBe(400);
        expect(body.type).toBe("warning");
        expect(body.error).toMatch(/only 1 supervising adult/);
        expect(body.error).toMatch(/within 15 seconds/);
        expect(update).toHaveBeenCalledWith({
            where: { id: DEPARTING_VISIT },
            data: { supervisionWarnedAt: expect.any(Date) },
        });
    });

    it("lets the checkout through on a scan that follows a fresh stamp", async () => {
        const { res, body } = await checkout([10, 20], new Date(Date.now() - 8_000));

        expect(res.status).toBe(200);
        expect(body.type).toBe("checkout");
    });

    it("confirms and departs on a second badge just 1s after the warning", async () => {
        // The ladder accepts any stamp inside the window, however close to the warning.
        const { res, body } = await checkout([10, 20], new Date(Date.now() - 1_000));

        expect(res.status).toBe(200);
        expect(body.type).toBe("checkout");
    });

    it("warns again once the countdown has run out", async () => {
        const { res, body } = await checkout([10, 20], new Date(Date.now() - 60_000));

        expect(res.status).toBe(400);
        expect(body.type).toBe("warning");
    });

    it("says NO supervising adult when the last one leaves", async () => {
        const { body } = await checkout([10]);
        expect(body.error).toMatch(/NO supervising adult/);
    });
});

describe("the confirm rung is youth-gated", () => {
    it("warns and lets the checkout through when no youth is in the building", async () => {
        const { res, body, update } = await checkout([10, 20], null, false);

        expect(res.status).toBe(200);
        expect(body.type).toBe("checkout");
        expect(body.warning).toMatch(/leaves only 1 supervising adult/i);
        expect(update).not.toHaveBeenCalled();
    });

    it("still warns when the last adult leaves an empty-of-youth room", async () => {
        const { res, body } = await checkout([10], null, false);

        expect(res.status).toBe(200);
        expect(body.warning).toMatch(/NO supervising adult/);
    });

    it("does not probe for youth on the warn-only rung", async () => {
        const { db } = await checkout([10, 20, 30]);
        expect((db.visit.findMany as jest.Mock)).toHaveBeenCalledTimes(1);
    });
});

describe("a youth an adult of their own household covers", () => {
    // The departing visit is household 10's adult; household 20's adult stays.
    it("owes no confirm when every youth left has a household adult inside", async () => {
        const { res, body, update } = await checkout([10, 20], null, true, [youthVisit(900, 20)]);

        expect(res.status).toBe(200);
        expect(body.warning).toMatch(/leaves only 1 supervising adult/i);
        expect(update).not.toHaveBeenCalled();
    });

    it("confirms when one covered and one uncovered youth are inside", async () => {
        const { res, body } = await checkout([10, 20], null, true, [youthVisit(900, 20), youthVisit(901, LONE_HOUSEHOLD)]);

        expect(res.status).toBe(400);
        expect(body.type).toBe("warning");
    });

    it("confirms when the departing adult is their youth's only household adult", async () => {
        const { res, body } = await checkout([10, 20], null, true, [youthVisit(900, 10)]);

        expect(res.status).toBe(400);
        expect(body.type).toBe("warning");
    });

    it("owes no confirm when another adult of the departing household stays with the youth", async () => {
        // Households 10, 10, 20: the count stays at two, so nothing is crossed at all.
        const { res, body } = await checkout([10, 10, 20], null, true, [youthVisit(900, 10)]);

        expect(res.status).toBe(200);
        expect(body.warning).toBeUndefined();
    });
});

describe("same household counts as one", () => {
    it("does not interrupt when the departing adult's household stays represented", async () => {
        // Three present, but two share household 10 — so two supervising adults
        // before, and still two after. Nothing crossed.
        const { res, body, update } = await checkout([10, 10, 20]);

        expect(res.status).toBe(200);
        expect(body.warning).toBeUndefined();
        expect(update).not.toHaveBeenCalled();
    });
});

describe("a departure that removes no supervising adult", () => {
    it("is not interrupted", async () => {
        // The departing visit is not among the supervising adults at all.
        const { db, update } = fakeDb([10, 20]);
        (db.visit.findMany as jest.Mock).mockResolvedValue(
            openVisits([10, 20]).map(v => ({ ...v, id: v.id === DEPARTING_VISIT ? 999 : v.id })),
        );

        const res = await wire(processCheckout(adult, DEPARTING_VISIT, db));

        expect(res.status).toBe(200);
        expect((await res.json()).warning).toBeUndefined();
        expect(update).not.toHaveBeenCalled();
    });
});

describe("a departure by someone who is not a supervising adult", () => {
    /** An uncleared parent (household 30) leaving, with their youth inside and `supervisors` staying. */
    async function parentLeaves(supervisors: number[], others: { id: number; person: object }[] = [youthVisit(900, 30)]) {
        const { db, update } = fakeDb([]);
        const staying = openVisits([0, ...supervisors]).slice(1);
        const parent = { id: DEPARTING_VISIT, person: { householdId: 30, isDeclaredAdult: true, dateOfBirth: null } };
        (db.visit.findMany as jest.Mock).mockImplementation(({ select }) =>
            select.person.select.lastBackgroundCheck ? staying : [...staying, parent, ...others]);
        const res = await wire(processCheckout(adult, DEPARTING_VISIT, db));
        return { res, body: await res.json(), update, db };
    }

    it("reads the room once for both the before and after answers", async () => {
        const { db } = await parentLeaves([20]);
        expect(db.visit.findMany).toHaveBeenCalledTimes(2);
    });

    it("is stopped when it leaves their own youth in a room short of supervising adults", async () => {
        const { res, body, update } = await parentLeaves([20]);

        expect(res.status).toBe(400);
        expect(body.type).toBe("warning");
        expect(body.error).toMatch(/only 1 supervising adult/);
        expect(update).toHaveBeenCalledWith({
            where: { id: DEPARTING_VISIT },
            data: { supervisionWarnedAt: expect.any(Date) },
        });
    });

    it("goes through quietly when two supervising adults stay", async () => {
        const { res, body, update } = await parentLeaves([20, 40]);

        expect(res.status).toBe(200);
        expect(body.warning).toBeUndefined();
        expect(update).not.toHaveBeenCalled();
    });

    it("goes through when another adult of their household stays with the youth", async () => {
        const otherParent = { id: 950, person: { householdId: 30, isDeclaredAdult: true, dateOfBirth: null } };
        const { res, update } = await parentLeaves([20], [youthVisit(900, 30), otherParent]);

        expect(res.status).toBe(200);
        expect(update).not.toHaveBeenCalled();
    });

    it("goes through when the youth left short was already uncovered before they left", async () => {
        const { res, update } = await parentLeaves([20], [youthVisit(900, LONE_HOUSEHOLD)]);

        expect(res.status).toBe(200);
        expect(update).not.toHaveBeenCalled();
    });
});

describe("youth check-in below two supervising adults", () => {
    it("warns but is never blocked", async () => {
        const { db } = fakeDb([10]);
        const res = await wire(processCheckin(youth, db));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.type).toBe("checkin");
        expect(body.warning).toMatch(/fewer than 2 supervising adults/i);
    });

    it("says nothing when the room is two deep", async () => {
        const { db } = fakeDb([10, 20]);
        expect((await (await wire(processCheckin(youth, db))).json()).warning).toBeUndefined();
    });

    it("says nothing when an adult of the youth's own household is inside", async () => {
        const { db } = fakeDb([10], null, false, [youthVisit(ARRIVING_VISIT, 10)]);
        expect((await (await wire(processCheckin(youth, db))).json()).warning).toBeUndefined();
    });

    it("warns a youth whose household has no adult inside, though another's does", async () => {
        const { db } = fakeDb([10], null, false, [youthVisit(901, 10), youthVisit(ARRIVING_VISIT, LONE_HOUSEHOLD)]);
        expect((await (await wire(processCheckin(youth, db))).json()).warning).toMatch(/fewer than 2 supervising adults/i);
    });

    it("costs an adult check-in no supervision query at all", async () => {
        const { db } = fakeDb([10]);
        await wire(processCheckin(adult, db));
        expect(db.visit.findMany).not.toHaveBeenCalled();
    });
});

describe("a REPLAYED departure skips the ladder entirely", () => {
    // The confirm rung answers 400 {type:"warning"} and records nothing, but the
    // outbox's classify_response acks that shape — a replayed departure hitting
    // it would be deleted from the queue with the visit still open, and no one
    // is at the reader to re-badge hours later.
    const SCANNED_AT = new Date("2026-08-19T14:00:00Z");

    it("departs instead of demanding a confirm nobody can give", async () => {
        const { db, update } = fakeDb([10, 20]);

        const res = await wire(processCheckout(adult, DEPARTING_VISIT, db, SCANNED_AT, true));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.type).toBe("checkout");
        expect(body.warning).toBeUndefined();
        expect(update).not.toHaveBeenCalled();
        expect(db.visit.findMany).not.toHaveBeenCalled();
        expect(processVisitCheckout).toHaveBeenCalledWith(DEPARTING_VISIT, SCANNED_AT, db, "SCANNER");
    });

    it("still departs when the room is left with NO supervising adult", async () => {
        const { db } = fakeDb([10]);

        const res = await wire(processCheckout(adult, DEPARTING_VISIT, db, SCANNED_AT, true));

        expect(res.status).toBe(200);
        expect((await res.json()).type).toBe("checkout");
    });

    it("leaves the live path on the ladder", async () => {
        const { res, body } = await checkout([10, 20]);
        expect(res.status).toBe(400);
        expect(body.type).toBe("warning");
    });
});

