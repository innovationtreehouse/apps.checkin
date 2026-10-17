/**
 * The scan route's post-commit side effects: carrying out recorded closes (a
 * failure is logged and left for the next re-drive) and the check-in/out email
 * (stamped with the scan's own event time, only for a toggle that happened).
 */
import prisma from "@/lib/prisma";
import { Prisma, type Person, type Visit } from "@/generated/prisma/client";
import { executePendingCloses } from "@/lib/attendance/close";
import { notifyScanOutcome } from "@/lib/attendance/scanNotify";
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
            $queryRaw: jest.fn(async (s: TemplateStringsArray, ...values: unknown[]) => {
                sweepTimes.push(Prisma.sql(s, ...values).values[0]);
                return [];
            }),
            facilityClose: {
                findFirst: jest.fn(async () => ({ id: 7, closedAt, closedById: 1 })),
                update,
            },
        }));

        await executePendingCloses();

        // The people to lock, then the sweep: both at the recorded close time.
        expect(sweepTimes).toEqual([closedAt.toISOString(), closedAt.toISOString()]);
        expect(update).toHaveBeenCalledWith({ where: { id: 7 }, data: { executedAt: expect.any(Date) } });
    });

    it("takes the person locks of everyone it may depart, then the facility lock", async () => {
        const closedAt = new Date("2026-10-01T21:30:00Z");
        findMany.mockResolvedValue([{ id: 7 }]);
        const locks: unknown[][] = [];
        const queryRaw = jest.fn().mockResolvedValueOnce([{ personId: 3 }, { personId: 9 }]).mockResolvedValue([]);
        tx.mockImplementation(async (cb: (t: unknown) => Promise<unknown>) => cb({
            $executeRaw: jest.fn(async (_s: TemplateStringsArray, ...values: unknown[]) => { locks.push(values); return 0; }),
            $queryRaw: queryRaw,
            facilityClose: {
                findFirst: jest.fn(async () => ({ id: 7, closedAt, closedById: 1 })),
                update: jest.fn(async () => ({})),
            },
        }));

        await executePendingCloses();

        expect(locks).toEqual([[3], [9], [1, 0]]);
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

    it("a failing close does not hold up the closes after it, and is not retried on every scan", async () => {
        findMany.mockResolvedValue([{ id: 11 }, { id: 12 }]);
        const ran: number[] = [];
        tx.mockImplementation(async (cb: (t: unknown) => Promise<unknown>) => cb({
            $executeRaw: jest.fn(async () => 0),
            $queryRaw: jest.fn(async () => []),
            facilityClose: {
                findFirst: jest.fn(async ({ where }: { where: { id: number } }) => {
                    if (where.id === 11) throw new Error("lock timeout");
                    ran.push(where.id);
                    return { id: where.id, closedAt: new Date(), closedById: 1 };
                }),
                update: jest.fn(async () => ({})),
            },
        }));

        await executePendingCloses();
        expect(ran).toContain(12);
        expect(logBackendError).toHaveBeenCalledTimes(1);

        tx.mockClear();
        findMany.mockResolvedValue([{ id: 11 }]);
        await executePendingCloses();
        expect(tx).not.toHaveBeenCalled();
    });

    it("gives the close transaction an explicit timeout", async () => {
        findMany.mockResolvedValue([{ id: 13 }]);
        tx.mockResolvedValue(false);

        await executePendingCloses();

        expect(tx).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ timeout: expect.any(Number) }));
    });
});

describe("notifyScanOutcome", () => {
    const at = new Date("2026-10-01T14:05:00Z");

    const person = { id: 7 } as Person;
    const visit = { id: 70 } as Visit;
    const checkin = { kind: "checkin", person, visit, supervisionShort: false, departedAtClose: false } as const;

    it("sends a check-in email stamped with the event time", async () => {
        await notifyScanOutcome(checkin, at);
        expect(sendCheckinNotifications).toHaveBeenCalledWith(7, "checkin", "SCANNER", at);
    });

    it("sends a check-out email stamped with the event time", async () => {
        await notifyScanOutcome({ kind: "checkout", person, visit, closed: false }, at);
        expect(sendCheckinNotifications).toHaveBeenCalledWith(7, "checkout", undefined, at);
    });

    it("sends nothing for a close-offer confirm, which departs no visit", async () => {
        await notifyScanOutcome({ kind: "checkout", person, visit: null, closed: true }, at);
        expect(sendCheckinNotifications).not.toHaveBeenCalled();
    });

    it("sends nothing for a replayed arrival that departed at a later close", async () => {
        await notifyScanOutcome({ ...checkin, departedAtClose: true }, at);
        expect(sendCheckinNotifications).not.toHaveBeenCalled();
    });
});
