/**
 * The last-keyholder warning is rendered on the kiosk screen. `Person.email` is
 * tier `pii`, so a person with no `name` must degrade to the email local-part —
 * never the full address (#329).
 *
 * The force close itself is bound to that warning: it proceeds only for a scan
 * echoing the confirm token minted with it, never for two badge events that
 * merely happen to be close together (B2 of #1529, §5.23).
 */
import type { Person } from "@/generated/prisma/client";
import type { DbClient } from "@/lib/db-client";
import { processCheckout, FORCE_CLOSE_CONFIRM_SECONDS } from "@/lib/scan-service";
import { processVisitCheckout } from "@/lib/attendanceTransitions";

jest.mock("@/lib/prisma", () => ({ __esModule: true, default: {} }));
jest.mock("@/lib/notifications", () => ({
    sendCheckinNotifications: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("@/lib/attendanceTransitions", () => ({
    findAssociatedEventAt: jest.fn().mockResolvedValue(null),
    processVisitCheckout: jest.fn().mockResolvedValue([]),
}));

const keyholder = { id: 1, isKeyholder: true } as Person;

/** Tx-shaped fake (no `$transaction`, so isRootClient() is false). */
function fakeDb(
    remaining: Array<{ name: string | null; email: string | null }>,
    storedToken: string | null = null
): DbClient {
    return {
        visit: {
            count: jest.fn().mockResolvedValue(0), // no other keyholders present
            findMany: jest.fn().mockResolvedValue(
                remaining.map((person, i) => ({ id: 100 + i, person }))
            ),
            findUnique: jest.fn().mockResolvedValue({ forceCloseToken: storedToken }),
            update: jest.fn().mockResolvedValue({}),
        },
        rawBadgeLog: {
            update: jest.fn().mockResolvedValue({}),
        },
    } as unknown as DbClient;
}

async function warningFor(remaining: Array<{ name: string | null; email: string | null }>) {
    const res = await processCheckout(keyholder, 42, "kiosk", fakeDb(remaining));
    expect(res.status).toBe(400);
    return (await res.json()) as { error: string; type: string };
}

it("renders a nameless person as the email local-part, not the address", async () => {
    const body = await warningFor([{ name: null, email: "jane.doe@example.com" }]);

    expect(body.type).toBe("warning");
    expect(body.error).toContain("jane.doe");
    expect(body.error).not.toContain("@");
    expect(body.error).not.toContain("example.com");
});

it("prefers the name when set, and mixes both without leaking", async () => {
    const body = await warningFor([
        { name: "Alex Rivera", email: "arivera@example.com" },
        { name: "   ", email: "blank.name@example.com" },
    ]);

    expect(body.error).toContain("Alex Rivera, blank.name");
    expect(body.error).not.toContain("@");
});

it("omits a person with neither name nor email rather than rendering an empty slot", async () => {
    const body = await warningFor([
        { name: null, email: null },
        { name: null, email: "solo@example.com" },
    ]);

    expect(body.error).toContain("solo");
    expect(body.error).not.toMatch(/, ,|:\n, /);
});

describe("force close is bound to the confirm token", () => {
    const present = [{ name: "Someone Inside", email: "inside@example.com" }];

    it("warns, mints a token, and hands it back with the countdown length", async () => {
        const db = fakeDb(present);
        const res = await processCheckout(keyholder, 42, "kiosk", db);
        const body = await res.json();

        expect(res.status).toBe(400);
        expect(body.facilityClosed).toBeUndefined();
        expect(body.forceCloseToken).toEqual(expect.any(String));
        expect(body.confirmSeconds).toBe(FORCE_CLOSE_CONFIRM_SECONDS);
        expect(body.error).toContain(`within ${FORCE_CLOSE_CONFIRM_SECONDS} seconds`);
        expect(db.visit.update).toHaveBeenCalledWith({
            where: { id: 42 },
            data: { forceCloseWarnedAt: expect.any(Date), forceCloseToken: body.forceCloseToken },
        });
    });

    it("closes the facility when the scan echoes the minted token", async () => {
        const db = fakeDb(present, "token-abc");
        const res = await processCheckout(keyholder, 42, "kiosk", db, "token-abc");

        expect(res.status).toBe(200);
        expect((await res.json()).facilityClosed).toBe(true);
        // Spent, not left behind on the now-departed visit.
        expect(db.visit.update).toHaveBeenCalledWith({
            where: { id: 42 },
            data: { forceCloseWarnedAt: null, forceCloseToken: null },
        });
    });

    it("honors a token minted before an outage — no elapsed-time gate (§5.23a)", async () => {
        // The visit was warned days ago; only the token match decides.
        const db = fakeDb(present, "token-from-tuesday");
        const res = await processCheckout(keyholder, 42, "kiosk", db, "token-from-tuesday");

        expect((await res.json()).facilityClosed).toBe(true);
    });

    it("re-warns with a NEW token when the scan carries no token", async () => {
        const db = fakeDb(present, "token-abc");
        const res = await processCheckout(keyholder, 42, "kiosk", db);
        const body = await res.json();

        expect(res.status).toBe(400);
        expect(body.type).toBe("warning");
        expect(body.forceCloseToken).not.toBe("token-abc");
    });

    it("re-warns rather than closing when the token does not match", async () => {
        // Deliberately a DIFFERENT length from the stored token: the compare is
        // timing-safe, and an unguarded timingSafeEqual throws on unequal lengths.
        const db = fakeDb(present, "token-abc");
        const res = await processCheckout(keyholder, 42, "kiosk", db, "token-guessed");

        expect(res.status).toBe(400);
        expect((await res.json()).type).toBe("warning");
    });
});

describe("a LIVE scan carrying a clientEventId still warns and confirms", () => {
    // D4 try-first puts the idempotency key on the live attempt, so the park
    // must key on the replay flag (null here), never on the id's presence.
    const present = [{ name: "Someone Inside", email: "inside@example.com" }];

    it("warns and mints on the first live scan even though the scan has an event id", async () => {
        const db = fakeDb(present);
        const res = await processCheckout(keyholder, 42, "kiosk", db, null, new Date(), null);

        expect(res.status).toBe(400);
        expect((await res.json()).type).toBe("warning");
        expect(db.visit.update).toHaveBeenCalledWith({
            where: { id: 42 },
            data: { forceCloseWarnedAt: expect.any(Date), forceCloseToken: expect.any(String) },
        });
        expect(db.rawBadgeLog.update).not.toHaveBeenCalled();
    });

    it("force-closes on the confirming live scan that echoes the token", async () => {
        const db = fakeDb(present, "token-live");
        const res = await processCheckout(keyholder, 42, "kiosk", db, "token-live", new Date(), null);

        expect(res.status).toBe(200);
        expect((await res.json()).facilityClosed).toBe(true);
    });
});

describe("F1 (narrowed by #1669): a replay force-closes only with a valid token", () => {
    const present = [{ name: "Someone Inside", email: "inside@example.com" }];
    const parked = (id: string) => ({
        where: { clientEventId: id },
        data: { reviewReason: "force_close_review" },
    });

    it("parks a token-less replay -- nobody ever confirmed it", async () => {
        const db = fakeDb(present, "token-abc");
        const res = await processCheckout(keyholder, 42, "kiosk", db, null, new Date(), "evt-replay-1");

        expect(res.status).toBe(200);
        expect((await res.json()).type).toBe("parked");
        // Never mints or stamps on a replay: an unattended countdown is not a confirm.
        expect(db.visit.update).not.toHaveBeenCalled();
        expect(db.rawBadgeLog.update).toHaveBeenCalledWith(parked("evt-replay-1"));
    });

    it("parks a replay whose token does not match the visit's live one", async () => {
        const db = fakeDb(present, "token-abc");
        const res = await processCheckout(keyholder, 42, "kiosk", db, "token-guessed", new Date(), "evt-replay-2");

        expect((await res.json()).type).toBe("parked");
        expect(db.visit.update).not.toHaveBeenCalled();
        expect(db.rawBadgeLog.update).toHaveBeenCalledWith(parked("evt-replay-2"));
    });

    it("parks a replay when the visit holds no token at all", async () => {
        const db = fakeDb(present, null);
        const res = await processCheckout(keyholder, 42, "kiosk", db, "token-stale", new Date(), "evt-replay-3");

        expect((await res.json()).type).toBe("parked");
        expect(db.visit.update).not.toHaveBeenCalled();
    });

    it("closes on a replay echoing the visit's token -- the pre-outage confirm (§5.23a)", async () => {
        const departedAt = new Date(Date.now() - 3 * 60_000);
        const db = fakeDb(present, "token-abc");
        const res = await processCheckout(keyholder, 42, "kiosk", db, "token-abc", departedAt, "evt-replay-4");

        expect(res.status).toBe(200);
        expect((await res.json()).facilityClosed).toBe(true);
        expect(db.rawBadgeLog.update).not.toHaveBeenCalled();
        expect(db.visit.update).toHaveBeenCalledWith({
            where: { id: 42 },
            data: { forceCloseWarnedAt: null, forceCloseToken: null },
        });
        expect(processVisitCheckout).toHaveBeenCalledWith(42, departedAt, db, "SCANNER");
    });

    it("two token-less replayed keyholder checkouts both park -- neither sweeps the room", async () => {
        const db = fakeDb(present, null);

        const first = await processCheckout(keyholder, 42, "kiosk", db, null, new Date(), "evt-replay-1");
        expect((await first.json()).type).toBe("parked");

        const second = await processCheckout(keyholder, 42, "kiosk", db, null, new Date(), "evt-replay-2");
        expect((await second.json()).type).toBe("parked");

        expect(db.visit.update).not.toHaveBeenCalled();
    });
});

describe("offline force-close: a client-confirmed replay closes without a server token (§5.23a extended)", () => {
    // The kiosk ran the two-scan warning+confirm locally while disconnected, so no
    // server token was ever minted. The confirmed flag rides the queued close and
    // stands in for the token -- honored ONLY on a replay, and only inside the same
    // isKeyholder / no-other-keyholder / others-present guards (fakeDb models one).
    const present = [{ name: "Someone Inside", email: "inside@example.com" }];

    it("closes on a token-less replay carrying forceCloseConfirmed", async () => {
        const db = fakeDb(present, null);
        const res = await processCheckout(keyholder, 42, "kiosk", db, null, new Date(), "evt-offline-1", true);

        expect(res.status).toBe(200);
        expect((await res.json()).facilityClosed).toBe(true);
        // Confirmed at the door -> it closes, never parks for review.
        expect(db.rawBadgeLog.update).not.toHaveBeenCalled();
        expect(db.visit.update).toHaveBeenCalledWith({
            where: { id: 42 },
            data: { forceCloseWarnedAt: null, forceCloseToken: null },
        });
    });

    it("still warns (server-authoritative) when forceCloseConfirmed rides a LIVE scan, not a replay", async () => {
        const db = fakeDb(present, null);
        const res = await processCheckout(keyholder, 42, "kiosk", db, null, new Date(), null, true);

        expect(res.status).toBe(400);
        expect((await res.json()).type).toBe("warning");
        expect(db.visit.update).toHaveBeenCalledWith({
            where: { id: 42 },
            data: { forceCloseWarnedAt: expect.any(Date), forceCloseToken: expect.any(String) },
        });
        expect(db.rawBadgeLog.update).not.toHaveBeenCalled();
    });
});
