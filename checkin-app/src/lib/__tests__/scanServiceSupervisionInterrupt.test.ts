/**
 * The departure interrupt ladder (#1436). Drives the REAL supervising-adult test
 * through processCheckout, so the two stay wired together:
 *
 *   third supervising adult leaves (two remain) → warning, checkout proceeds
 *   next one leaves, a youth is here            → warning AND badge-again confirm
 *   next one leaves, no youth is here           → warning, checkout proceeds
 *
 * The keyholder close-guard is a separate interrupt with its own stamp; the
 * participant here is not a keyholder, so only the supervision rungs run.
 */
import type { Person } from "@/generated/prisma/client";
import type { DbClient } from "@/lib/db-client";
import { processVisitCheckout } from "@/lib/attendanceTransitions";
import { processCheckin, processCheckout } from "@/lib/scan-service";

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

/** The supervising-adult query and the youth probe both hit `visit.findMany`;
 *  the probe is the one filtering on `isDeclaredAdult: false`. Youth present by
 *  default — the confirm rung is gated on it. */
function fakeDb(householdIds: number[], warnedAt: Date | null = null, youthPresent = true) {
    const update = jest.fn().mockResolvedValue({});
    const db = {
        // The facility advisory lock is a no-op against a fake client.
        $executeRaw: jest.fn().mockResolvedValue(0),
        boardSettings: { findUnique: jest.fn().mockResolvedValue({ orgMembershipYearBoundary: null, bgRecheckMonths: 0 }) },
        visit: {
            findFirst: jest.fn().mockResolvedValue(null),
            count: jest.fn().mockResolvedValue(1),
            findMany: jest.fn().mockImplementation(({ where }) =>
                where.person?.isDeclaredAdult === false
                    ? (youthPresent ? [{ person: { dateOfBirth: new Date("2015-01-01") } }] : [])
                    : openVisits(householdIds)),
            findUnique: jest.fn().mockResolvedValue({ supervisionWarnedAt: warnedAt }),
            create: jest.fn().mockResolvedValue({ id: 500 }),
            update,
        },
    };
    return { db: db as unknown as DbClient, update };
}

async function checkout(householdIds: number[], warnedAt: Date | null = null, youthPresent = true) {
    const { db, update } = fakeDb(householdIds, warnedAt, youthPresent);
    const res = await processCheckout(adult, DEPARTING_VISIT, "kiosk", db);
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

    it("confirms and departs on a second badge just 1s after the warning (#1347 PR-0)", async () => {
        // The route's debounce used to swallow exactly this scan; the ladder
        // itself was never the problem -- it accepts any stamp inside the
        // window, however close to the warning.
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

        const res = await processCheckout(adult, DEPARTING_VISIT, "kiosk", db);

        expect(res.status).toBe(200);
        expect((await res.json()).warning).toBeUndefined();
        expect(update).not.toHaveBeenCalled();
    });
});

describe("youth check-in below two supervising adults", () => {
    it("warns but is never blocked", async () => {
        const { db } = fakeDb([10]);
        const res = await processCheckin(youth, "kiosk", db);
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.type).toBe("checkin");
        expect(body.warning).toMatch(/fewer than 2 supervising adults/i);
    });

    it("says nothing when the room is two deep", async () => {
        const { db } = fakeDb([10, 20]);
        expect((await (await processCheckin(youth, "kiosk", db)).json()).warning).toBeUndefined();
    });

    it("costs an adult check-in no supervision query at all", async () => {
        const { db } = fakeDb([10]);
        await processCheckin(adult, "kiosk", db);
        expect(db.visit.findMany).not.toHaveBeenCalled();
    });
});

describe("a REPLAYED departure skips the ladder entirely (#1257)", () => {
    // The confirm rung answers 400 {type:"warning"} and records nothing, but the
    // outbox's classify_response acks that shape — a replayed departure hitting
    // it would be deleted from the queue with the visit still open, and no one
    // is at the reader to re-badge hours later.
    const SCANNED_AT = new Date("2026-08-19T14:00:00Z");

    it("departs instead of demanding a confirm nobody can give", async () => {
        const { db, update } = fakeDb([10, 20]);

        const res = await processCheckout(adult, DEPARTING_VISIT, "kiosk", db, null, SCANNED_AT, "evt-1");
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

        const res = await processCheckout(adult, DEPARTING_VISIT, "kiosk", db, null, SCANNED_AT, "evt-2");

        expect(res.status).toBe(200);
        expect((await res.json()).type).toBe("checkout");
    });

    it("leaves the live path on the ladder", async () => {
        const { res, body } = await checkout([10, 20]);
        expect(res.status).toBe(400);
        expect(body.type).toBe("warning");
    });
});

describe("a web (session) checkout skips the ladder (rule: badge scanner only)", () => {
    // docs/rules/attendance-checkin.md, Supervision: whoever checks someone out
    // from the web is not at the reader and cannot re-badge to confirm.
    it("departs without a confirm when the room would drop below two deep", async () => {
        const { db, update } = fakeDb([10, 20]);

        const res = await processCheckout(adult, DEPARTING_VISIT, "session", db);
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.type).toBe("checkout");
        expect(body.warning).toBeUndefined();
        expect(update).not.toHaveBeenCalled();
        expect(db.visit.findMany).not.toHaveBeenCalled();
    });

    it("leaves the kiosk badge on the ladder", async () => {
        const { db } = fakeDb([10, 20]);

        const res = await processCheckout(adult, DEPARTING_VISIT, "kiosk", db);
        const body = await res.json();

        expect(res.status).toBe(400);
        expect(body.type).toBe("warning");
        expect(body.error).toMatch(/within 15 seconds/);
    });
});
