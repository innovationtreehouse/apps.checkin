/**
 * The scan route's post-commit side effects: the facility-close sweep (retried
 * once, then recorded in ErrorLog) and the check-in/out email (stamped with the
 * scan's own event time, only for a toggle that actually happened).
 */
import prisma from "@/lib/prisma";
import { finalizeFacilityClose, notifyScanOutcome } from "@/lib/scan-service";
import { sendCheckinNotifications } from "@/lib/notifications";
import { logBackendError } from "@/lib/logger";

jest.mock("@/lib/prisma", () => ({ __esModule: true, default: { $transaction: jest.fn() } }));
jest.mock("@/lib/notifications", () => ({
    sendCheckinNotifications: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("@/lib/logger", () => ({ logBackendError: jest.fn() }));
jest.mock("@/lib/postEventEmails", () => ({ processPostEventEmails: jest.fn().mockResolvedValue(undefined) }));

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const tx = prisma.$transaction as jest.Mock;

beforeEach(() => jest.clearAllMocks());

describe("finalizeFacilityClose", () => {
    it("retries a failed sweep once and does not log when the retry succeeds", async () => {
        tx.mockRejectedValueOnce(new Error("Transaction already closed")).mockResolvedValueOnce(undefined);

        await finalizeFacilityClose(json({ facilityClosed: true }));

        expect(tx).toHaveBeenCalledTimes(2);
        expect(logBackendError).not.toHaveBeenCalled();
    });

    it("records a second failure in ErrorLog instead of throwing", async () => {
        const err = new Error("connection dropped");
        tx.mockRejectedValueOnce(new Error("first")).mockRejectedValueOnce(err);

        await expect(finalizeFacilityClose(json({ facilityClosed: true }))).resolves.toBeUndefined();

        expect(tx).toHaveBeenCalledTimes(2);
        expect(logBackendError).toHaveBeenCalledWith(err, "facility-close");
    });

    it("carries the late-close time into the retried sweep, not the retry's own clock", async () => {
        const closeTime = new Date("2026-10-01T21:30:00Z");
        const sweepTimes: unknown[] = [];
        let attempt = 0;
        tx.mockImplementation(async (cb: (t: unknown) => Promise<unknown>) => {
            attempt++;
            const fakeTx = {
                $executeRaw: jest.fn(async (_strings: TemplateStringsArray, ...values: unknown[]) => {
                    if (values.includes(closeTime.toISOString())) sweepTimes.push(values[0]);
                    return 0;
                }),
            };
            await cb(fakeTx);
            if (attempt === 1) throw new Error("Transaction already closed");
        });

        await finalizeFacilityClose(json({ facilityClosed: true }), closeTime);

        expect(sweepTimes).toEqual([closeTime.toISOString(), closeTime.toISOString()]);
        expect(logBackendError).not.toHaveBeenCalled();
    });

    it("does nothing unless the response reports facilityClosed", async () => {
        await finalizeFacilityClose(json({ type: "checkout", facilityClosed: false }));
        expect(tx).not.toHaveBeenCalled();
    });
});

describe("notifyScanOutcome", () => {
    const at = new Date("2026-10-01T14:05:00Z");

    it("sends a check-in email stamped with the event time", async () => {
        await notifyScanOutcome(json({ type: "checkin", participant: { id: 7 } }), at);
        expect(sendCheckinNotifications).toHaveBeenCalledWith(7, "checkin", "SCANNER", at);
    });

    it("sends a check-out email stamped with the event time", async () => {
        await notifyScanOutcome(json({ type: "checkout", participant: { id: 7 } }), at);
        expect(sendCheckinNotifications).toHaveBeenCalledWith(7, "checkout", undefined, at);
    });

    it("sends nothing for a close-offer confirm, which departs no visit", async () => {
        await notifyScanOutcome(json({ type: "checkout", participant: { id: 7 }, visit: null, facilityClosed: true }), at);
        expect(sendCheckinNotifications).not.toHaveBeenCalled();
    });

    it.each(["duplicate_ignored", "ignored_debounce", "parked", "warning"])("sends nothing for %s", async (type) => {
        await notifyScanOutcome(json({ type, participant: { id: 7 } }), at);
        expect(sendCheckinNotifications).not.toHaveBeenCalled();
    });
});
