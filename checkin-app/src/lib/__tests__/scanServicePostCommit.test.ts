/**
 * The scan route's post-commit side effects: carrying out recorded closes (a
 * failure is logged and left for the next re-drive) and the check-in/out email
 * (stamped with the scan's own event time, only for a toggle that happened).
 */
import prisma from "@/lib/prisma";
import { executePendingCloses, notifyScanOutcome } from "@/lib/scan-service";
import { sendCheckinNotifications } from "@/lib/notifications";
import { logBackendError } from "@/lib/logger";

jest.mock("@/lib/prisma", () => ({
    __esModule: true,
    default: { $transaction: jest.fn(), facilityClose: { findMany: jest.fn() } },
}));
jest.mock("@/lib/notifications", () => ({
    sendCheckinNotifications: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("@/lib/logger", () => ({ logBackendError: jest.fn() }));
jest.mock("@/lib/postEventEmails", () => ({ processPostEventEmails: jest.fn().mockResolvedValue(undefined) }));

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const tx = prisma.$transaction as jest.Mock;
const findMany = prisma.facilityClose.findMany as jest.Mock;

beforeEach(() => jest.clearAllMocks());

describe("executePendingCloses", () => {
    it("does nothing when every close has run", async () => {
        findMany.mockResolvedValue([]);
        await executePendingCloses();
        expect(tx).not.toHaveBeenCalled();
    });

    it("sweeps at the recorded close time and marks the close executed", async () => {
        const closedAt = new Date("2026-10-01T21:30:00Z");
        findMany.mockResolvedValue([{ id: 7 }]);
        const sweepTimes: unknown[] = [];
        const update = jest.fn(async () => ({}));
        tx.mockImplementation(async (cb: (t: unknown) => Promise<unknown>) => cb({
            $executeRaw: jest.fn(async () => 0),
            $queryRaw: jest.fn(async (_s: TemplateStringsArray, ...values: unknown[]) => {
                sweepTimes.push(values[0]);
                return [];
            }),
            facilityClose: {
                findFirst: jest.fn(async () => ({ id: 7, closedAt, closedById: 1 })),
                update,
            },
        }));

        await executePendingCloses();

        expect(sweepTimes).toEqual([closedAt.toISOString()]);
        expect(update).toHaveBeenCalledWith({ where: { id: 7 }, data: { executedAt: expect.any(Date) } });
    });

    it("skips a close another executor already ran", async () => {
        findMany.mockResolvedValue([{ id: 7 }]);
        const queryRaw = jest.fn();
        tx.mockImplementation(async (cb: (t: unknown) => Promise<unknown>) => cb({
            $executeRaw: jest.fn(async () => 0),
            $queryRaw: queryRaw,
            facilityClose: { findFirst: jest.fn(async () => null), update: jest.fn() },
        }));

        await executePendingCloses();

        expect(queryRaw).not.toHaveBeenCalled();
    });

    it("logs a failed sweep instead of throwing; the close stays recorded for the next re-drive", async () => {
        const err = new Error("connection dropped");
        findMany.mockResolvedValue([{ id: 7 }]);
        tx.mockRejectedValue(err);

        await expect(executePendingCloses()).resolves.toBeUndefined();

        expect(logBackendError).toHaveBeenCalledWith(err, "facility-close");
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
