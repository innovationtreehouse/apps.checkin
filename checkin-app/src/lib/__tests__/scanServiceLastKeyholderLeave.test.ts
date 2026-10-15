/**
 * A keyholder's checkout at the kiosk. From a kiosk that sends close requests it
 * only checks that keyholder out; the last recorded keyholder's checkout is
 * audited as a leave. From an older kiosk the checkout still decides the close:
 * the kiosk's `shownEmpty` when sent, else the server's records — a leave with a
 * close offer, or a close (docs/rules/attendance-checkin.md, Opening and closing).
 *
 * The offer is rendered on the kiosk screen, a public display that mostly lists
 * minors. It names people the way the kiosk roster does — nickname, else first
 * name, last initial only to tell two apart — never a last name; a person with
 * no `name` degrades to the email local-part, never the address
 * (docs/rules/attendance-checkin.md, "The kiosk").
 */
import type { Person } from "@/generated/prisma/client";
import type { DbClient } from "@/lib/db-client";
import { processCheckout, FORCE_CLOSE_CONFIRM_SECONDS, type LegacyKiosk } from "@/lib/scan-service";
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
const older: LegacyKiosk = { shownEmpty: null, clientEventId: "evt-replay-1" };

/** Tx-shaped fake: no other keyholder recorded, `remaining` inside. */
function fakeDb(remaining: Array<{ name: string | null; email: string | null }>): DbClient {
    return {
        visit: {
            count: jest.fn().mockResolvedValue(0),
            findMany: jest.fn().mockResolvedValue(remaining.map((person, i) => ({ id: 100 + i, person }))),
            findFirst: jest.fn().mockResolvedValue({ id: 77 }),
            update: jest.fn().mockResolvedValue({}),
        },
        auditLog: { create: jest.fn().mockResolvedValue({}) },
        rawBadgeLog: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        facilityClose: { create: jest.fn().mockResolvedValue({ id: 5 }) },
    } as unknown as DbClient;
}

/** processCheckout with only the kiosk generation and replay-ness varied. */
const badge = (db: DbClient, legacy: LegacyKiosk | null, isReplay = false) =>
    processCheckout(keyholder, 42, "kiosk", db, new Date(), isReplay, false, legacy);

beforeEach(() => {
    jest.mocked(processVisitCheckout).mockResolvedValue([{ id: 77 }] as never);
});

const present = [{ name: "Someone Inside", email: "inside@example.com" }];

describe("from a kiosk that sends close requests, a keyholder checkout only checks out", () => {
    it("closes nothing and offers nothing, even with nobody else recorded", async () => {
        const db = fakeDb([]);
        const body = await (await badge(db, null)).json();

        expect(body).toMatchObject({ type: "checkout", facilityClosed: false });
        expect(body.forceCloseToken).toBeUndefined();
        expect(db.facilityClose.create).not.toHaveBeenCalled();
    });

    it("audits the last recorded keyholder's checkout as a leave with the handover not named", async () => {
        const db = fakeDb(present);
        await badge(db, null);

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
});

describe("from an older kiosk, the close offer names people as the kiosk roster does", () => {
    async function offerFor(remaining: Array<{ name: string | null; email: string | null }>) {
        const res = await badge(fakeDb(remaining), older);
        expect(res.status).toBe(200);
        return (await res.json()) as { closePrompt: string; type: string };
    }

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

describe("from an older kiosk, the last keyholder's single badge with others inside is a leave", () => {
    it("checks them out and offers the close, saying no other keyholder is checked in, storing no token", async () => {
        const db = fakeDb(present);
        const body = await (await badge(db, older)).json();

        expect(body.type).toBe("checkout");
        expect(body.facilityClosed).toBe(false);
        expect(body.closePrompt).toContain("No other keyholder is checked in");
        expect(body.closePrompt).toContain(`within ${FORCE_CLOSE_CONFIRM_SECONDS} seconds`);
        expect(body.confirmSeconds).toBe(FORCE_CLOSE_CONFIRM_SECONDS);
        expect(body.forceCloseToken).toEqual(expect.any(String));
        expect(processVisitCheckout).toHaveBeenCalledWith(42, expect.any(Date), db, "SCANNER");
        expect(db.visit.update).not.toHaveBeenCalled();
    });

    it("checks a replay out as a leave, with no offer, flagged for review", async () => {
        const db = fakeDb(present);
        const body = await (await badge(db, older, true)).json();

        expect(body.facilityClosed).toBe(false);
        expect(body.forceCloseToken).toBeUndefined();
        expect(db.auditLog.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                newData: expect.objectContaining({ choice: "leave", via: "KIOSK_OFFLINE", handoverToId: null }),
            }),
        });
        expect(db.rawBadgeLog.updateMany).toHaveBeenCalledWith({
            where: { clientEventId: "evt-replay-1" },
            data: { reviewReason: "force_close_review" },
        });
    });

    it("records a close, with no offer, when nobody else is recorded", async () => {
        const db = fakeDb([]);
        const body = await (await badge(db, older)).json();

        expect(body.facilityClosed).toBe(true);
        expect(body.forceCloseToken).toBeUndefined();
        expect(db.auditLog.create).not.toHaveBeenCalled();
        expect(db.facilityClose.create).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ closedById: 1, via: "KIOSK", executedAt: null, closerVisitId: 77 }),
        }));
    });
});

describe("from an older kiosk, what the kiosk showed decides (shownEmpty; true is a close request, in the route)", () => {
    it("leaves and offers the close when the kiosk showed others, though the server records nobody", async () => {
        const db = fakeDb([]);
        const body = await (await badge(db, { shownEmpty: false, clientEventId: null })).json();

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
        expect((await (await badge(fakeDb([]), older)).json()).facilityClosed).toBe(true);
        expect((await (await badge(fakeDb(present), older)).json()).facilityClosed).toBe(false);
    });
});
