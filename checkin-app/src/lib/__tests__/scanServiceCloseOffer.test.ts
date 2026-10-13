/**
 * Any keyholder can close the building with a double scan, even while another
 * keyholder is still recorded inside — the other is a forgotten badge-out
 * (docs/rules/attendance-checkin.md). Their checkout goes through and offers the
 * close; the second badge echoing that offer's token closes the facility.
 */
import type { Person } from "@/generated/prisma/client";
import type { DbClient } from "@/lib/db-client";
import { closeOnOfferConfirm, processCheckout, FORCE_CLOSE_CONFIRM_SECONDS } from "@/lib/scan-service";
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

/** Tx-shaped fake (no `$transaction`, so isRootClient() is false). */
function fakeDb(otherKeyholders: number, offered: { id: number } | null = null): DbClient {
    return {
        visit: {
            count: jest.fn().mockResolvedValue(otherKeyholders),
            findMany: jest.fn().mockResolvedValue([]),
            findFirst: jest.fn().mockResolvedValue(offered),
            update: jest.fn().mockResolvedValue({}),
        },
    } as unknown as DbClient;
}

beforeEach(() => {
    jest.mocked(processVisitCheckout).mockResolvedValue([{ id: 77 }] as never);
});

describe("checkout while another keyholder is recorded inside", () => {
    it("checks out and offers the close with a token on the departed visit", async () => {
        const db = fakeDb(1);
        const res = await processCheckout(keyholder, 42, "kiosk", db);
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.type).toBe("checkout");
        expect(body.facilityClosed).toBe(false);
        expect(body.forceCloseToken).toEqual(expect.any(String));
        expect(body.confirmSeconds).toBe(FORCE_CLOSE_CONFIRM_SECONDS);
        expect(body.closePrompt).toContain("close the building");
        expect(db.visit.update).toHaveBeenCalledWith({
            where: { id: 77 },
            data: { forceCloseWarnedAt: expect.any(Date), forceCloseToken: body.forceCloseToken },
        });
    });

    it("offers nothing on a replay -- nobody is at the reader to badge again", async () => {
        const db = fakeDb(1);
        const body = await (await processCheckout(keyholder, 42, "kiosk", db, null, new Date(), "evt-1")).json();

        expect(body.type).toBe("checkout");
        expect(body.forceCloseToken).toBeUndefined();
        expect(db.visit.update).not.toHaveBeenCalled();
    });

    it("offers nothing to a web checkout", async () => {
        const body = await (await processCheckout(keyholder, 42, "session", fakeDb(1))).json();
        expect(body.forceCloseToken).toBeUndefined();
    });

    it("offers nothing to a non-keyholder", async () => {
        const member = { id: 2, isKeyholder: false } as Person;
        const body = await (await processCheckout(member, 42, "kiosk", fakeDb(1))).json();
        expect(body.forceCloseToken).toBeUndefined();
    });
});

describe("closeOnOfferConfirm", () => {
    it("closes the facility when the scan echoes the offer's token, and spends it", async () => {
        const db = fakeDb(1, { id: 77 });
        const res = await closeOnOfferConfirm(keyholder, "kiosk", db, "tok", null, false);

        expect(res).not.toBeNull();
        expect((await res!.json()).facilityClosed).toBe(true);
        expect(db.visit.findFirst).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({ personId: 1, forceCloseToken: "tok", departedAt: { not: null } }),
        }));
        expect(db.visit.update).toHaveBeenCalledWith({
            where: { id: 77 },
            data: { forceCloseWarnedAt: null, forceCloseToken: null },
        });
    });

    it("is not a confirm when no departed visit holds the token", async () => {
        expect(await closeOnOfferConfirm(keyholder, "kiosk", fakeDb(1, null), "tok", null, false)).toBeNull();
    });

    it("is not a confirm without a token on a live scan, even flagged offline-confirmed", async () => {
        expect(await closeOnOfferConfirm(keyholder, "kiosk", fakeDb(1), null, null, true)).toBeNull();
    });

    it("closes on a replay carrying the kiosk's offline confirm", async () => {
        const db = fakeDb(1);
        const res = await closeOnOfferConfirm(keyholder, "kiosk", db, null, "evt-2", true);

        expect((await res!.json()).facilityClosed).toBe(true);
        expect(db.visit.findFirst).not.toHaveBeenCalled();
    });

    it("never closes for a non-keyholder", async () => {
        const member = { id: 2, isKeyholder: false } as Person;
        expect(await closeOnOfferConfirm(member, "kiosk", fakeDb(1, { id: 77 }), "tok", "evt-3", true)).toBeNull();
    });
});

it("closes on an offline-confirmed replay while another keyholder is still recorded", async () => {
    const db = fakeDb(1);
    const body = await (await processCheckout(keyholder, 42, "kiosk", db, null, new Date(), "evt-4", true)).json();

    expect(body.facilityClosed).toBe(true);
    expect(body.forceCloseToken).toBeUndefined();
    expect(db.visit.update).toHaveBeenCalledWith({
        where: { id: 42 },
        data: { forceCloseWarnedAt: null, forceCloseToken: null },
    });
});
