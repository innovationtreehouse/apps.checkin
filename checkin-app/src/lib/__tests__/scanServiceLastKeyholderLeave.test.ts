/**
 * The last keyholder's single badge with others inside is a leave: it checks
 * them out and offers the close; a second badge echoing the offer's token closes
 * (docs/rules/attendance-checkin.md, Opening and closing).
 *
 * The offer is rendered on the kiosk screen, a public display that mostly lists
 * minors. It names people the way the kiosk roster does — nickname, else first
 * name, last initial only to tell two apart — never a last name; a person with
 * no `name` degrades to the email local-part, never the address
 * (docs/rules/attendance-checkin.md, "The kiosk").
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
    processVisitCheckout: jest.fn(),
}));
jest.mock("@/lib/supervision", () => ({
    MIN_SUPERVISING_ADULTS: 2,
    supervisingAdultVisits: jest.fn().mockResolvedValue([]),
    supervisingAdultCount: jest.fn().mockReturnValue(0),
    youthIsPresent: jest.fn().mockResolvedValue(false),
}));

const keyholder = { id: 1, isKeyholder: true } as Person;

/** Tx-shaped fake (not a registered root client, so isRootClient() is false). */
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
        auditLog: {
            create: jest.fn().mockResolvedValue({}),
        },
        rawBadgeLog: {
            update: jest.fn().mockResolvedValue({}),
        },
    } as unknown as DbClient;
}

beforeEach(() => {
    jest.mocked(processVisitCheckout).mockResolvedValue([{ id: 77 }] as never);
});

async function offerFor(remaining: Array<{ name: string | null; email: string | null }>) {
    const res = await processCheckout(keyholder, 42, "kiosk", fakeDb(remaining));
    expect(res.status).toBe(200);
    return (await res.json()) as { closePrompt: string; type: string };
}

describe("the close offer names people as the kiosk roster does", () => {
    it("renders a nameless person as the email local-part, not the address", async () => {
        const body = await offerFor([{ name: null, email: "jane.doe@example.com" }]);

        expect(body.closePrompt).toContain("jane.doe");
        expect(body.closePrompt).not.toContain("@");
        expect(body.closePrompt).not.toContain("example.com");
    });

    it("prefers the name when set, and mixes both without leaking", async () => {
        const body = await offerFor([
            { name: "Alex Rivera", email: "arivera@example.com" },
            { name: "   ", email: "blank.name@example.com" },
        ]);

        expect(body.closePrompt).toContain("Alex, blank.name");
        expect(body.closePrompt).not.toContain("@");
    });

    it("never shows a last name — only the initial that tells two people apart", async () => {
        const body = await offerFor([
            { name: "Sam Lee", email: null },
            { name: "Sam Park", email: null },
            { name: "Jordan Quinlan-Smith", email: null },
        ]);

        expect(body.closePrompt).toContain("Sam L., Sam P., Jordan");
        expect(body.closePrompt).not.toMatch(/Lee|Park|Quinlan|Smith/);
    });

    it("omits a person with neither name nor email rather than rendering an empty slot", async () => {
        const body = await offerFor([
            { name: null, email: null },
            { name: null, email: "solo@example.com" },
        ]);

        expect(body.closePrompt).toContain("solo");
        expect(body.closePrompt).not.toMatch(/, ,|: ,/);
    });
});

describe("the last keyholder's single badge is a leave", () => {
    const present = [{ name: "Someone Inside", email: "inside@example.com" }];

    it("checks them out and offers the close, saying no other keyholder is checked in", async () => {
        const db = fakeDb(present);
        const res = await processCheckout(keyholder, 42, "kiosk", db);
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.type).toBe("checkout");
        expect(body.facilityClosed).toBe(false);
        expect(body.closePrompt).toContain("No other keyholder is checked in");
        expect(body.closePrompt).toContain(`within ${FORCE_CLOSE_CONFIRM_SECONDS} seconds`);
        expect(body.confirmSeconds).toBe(FORCE_CLOSE_CONFIRM_SECONDS);
        expect(processVisitCheckout).toHaveBeenCalledWith(42, expect.any(Date), db, "SCANNER");
        // The offer's token rides the departed visit, for closeOnOfferConfirm.
        expect(db.visit.update).toHaveBeenCalledWith({
            where: { id: 77 },
            data: { forceCloseWarnedAt: expect.any(Date), forceCloseToken: body.forceCloseToken },
        });
    });

    it("audits the leave with the handover not named", async () => {
        const db = fakeDb(present);
        await processCheckout(keyholder, 42, "kiosk", db);

        expect(db.auditLog.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                action: "EDIT",
                tableName: "Visit",
                affectedEntityId: 77,
                secondaryAffectedEntity: 1,
                newData: { type: "last_keyholder_choice", choice: "leave", via: "KIOSK", handoverToId: null, othersInside: 1 },
            }),
        });
    });

    it("checks a token-less replay out as a leave, with no offer and nothing parked", async () => {
        const db = fakeDb(present);
        const body = await (await processCheckout(keyholder, 42, "kiosk", db, null, new Date(), "evt-replay-1")).json();

        expect(body.type).toBe("checkout");
        expect(body.facilityClosed).toBe(false);
        expect(body.forceCloseToken).toBeUndefined();
        expect(db.rawBadgeLog.update).not.toHaveBeenCalled();
        expect(db.auditLog.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                newData: expect.objectContaining({ choice: "leave", via: "KIOSK_OFFLINE", handoverToId: null }),
            }),
        });
    });

    it("leaves rather than closing when the token does not match", async () => {
        // Deliberately a DIFFERENT length from the stored token: the compare is
        // timing-safe, and an unguarded timingSafeEqual throws on unequal lengths.
        const db = fakeDb(present, "token-abc");
        const body = await (await processCheckout(keyholder, 42, "kiosk", db, "token-guessed")).json();

        expect(body.facilityClosed).toBe(false);
        expect(body.forceCloseToken).not.toBe("token-abc");
    });

    it("closes with no offer when nobody else is inside", async () => {
        const db = fakeDb([]);
        const body = await (await processCheckout(keyholder, 42, "kiosk", db)).json();

        expect(body.facilityClosed).toBe(true);
        expect(body.forceCloseToken).toBeUndefined();
        expect(db.auditLog.create).not.toHaveBeenCalled();
    });
});

describe("a token on the still-open visit closes", () => {
    const present = [{ name: "Someone Inside", email: "inside@example.com" }];

    it("closes the facility when the scan echoes it, and spends it", async () => {
        const db = fakeDb(present, "token-abc");
        const res = await processCheckout(keyholder, 42, "kiosk", db, "token-abc");

        expect(res.status).toBe(200);
        expect((await res.json()).facilityClosed).toBe(true);
        expect(db.visit.update).toHaveBeenCalledWith({
            where: { id: 42 },
            data: { forceCloseWarnedAt: null, forceCloseToken: null },
        });
        expect(db.auditLog.create).not.toHaveBeenCalled();
    });

    it("closes on a replay echoing it, at the scan time (§5.23a)", async () => {
        const departedAt = new Date(Date.now() - 3 * 60_000);
        const db = fakeDb(present, "token-abc");
        const res = await processCheckout(keyholder, 42, "kiosk", db, "token-abc", departedAt, "evt-replay-4");

        expect((await res.json()).facilityClosed).toBe(true);
        expect(processVisitCheckout).toHaveBeenCalledWith(42, departedAt, db, "SCANNER");
    });
});

describe("offline force-close: a client-confirmed replay closes without a server token (§5.23a extended)", () => {
    const present = [{ name: "Someone Inside", email: "inside@example.com" }];

    it("closes on a token-less replay carrying forceCloseConfirmed", async () => {
        const db = fakeDb(present, null);
        const res = await processCheckout(keyholder, 42, "kiosk", db, null, new Date(), "evt-offline-1", true);

        expect((await res.json()).facilityClosed).toBe(true);
        expect(db.rawBadgeLog.update).not.toHaveBeenCalled();
    });

    it("offers rather than closes when forceCloseConfirmed rides a LIVE scan", async () => {
        const db = fakeDb(present, null);
        const body = await (await processCheckout(keyholder, 42, "kiosk", db, null, new Date(), null, true)).json();

        expect(body.facilityClosed).toBe(false);
        expect(body.forceCloseToken).toEqual(expect.any(String));
    });
});

describe("the kiosk's view of who is inside decides (shownEmpty)", () => {
    const present = [{ name: "Someone Inside", email: "inside@example.com" }];
    /** processCheckout with only the kiosk's view varied: live, no token. */
    const badge = (db: DbClient, shownEmpty: boolean | null) =>
        processCheckout(keyholder, 42, "kiosk", db, null, new Date(), null, false, false, shownEmpty);

    it("closes on one live badge when the kiosk showed nobody, whoever the server records", async () => {
        const db = fakeDb(present);
        const body = await (await badge(db, true)).json();

        expect(body.facilityClosed).toBe(true);
        expect(body.forceCloseToken).toBeUndefined();
        expect(db.auditLog.create).not.toHaveBeenCalled();
    });

    it("closes on one live badge when the kiosk showed nobody, even with another keyholder recorded", async () => {
        const db = fakeDb(present);
        jest.mocked(db.visit.count).mockResolvedValue(1);
        expect((await (await badge(db, true)).json()).facilityClosed).toBe(true);
    });

    it("leaves and offers the close when the kiosk showed others, though the server records nobody", async () => {
        const db = fakeDb([]);
        const body = await (await badge(db, false)).json();

        expect(body.facilityClosed).toBe(false);
        expect(body.forceCloseToken).toEqual(expect.any(String));
        expect(body.closePrompt).toMatch(/^No other keyholder is checked in\. Badge again/);
        expect(db.auditLog.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                newData: expect.objectContaining({ choice: "leave", via: "KIOSK", handoverToId: null, othersInside: 0 }),
            }),
        });
    });

    it("follows the server's records when the kiosk does not say", async () => {
        expect((await (await badge(fakeDb([]), null)).json()).facilityClosed).toBe(true);
        expect((await (await badge(fakeDb(present), null)).json()).facilityClosed).toBe(false);
    });
});
