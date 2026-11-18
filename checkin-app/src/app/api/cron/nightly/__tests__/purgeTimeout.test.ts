/**
 * @jest-environment node
 */
/**
 * The nightly run's lock-holding transactions can outlast Prisma's 5-second
 * default after a large import or backlog, so each sets an explicit timeout.
 */
import prisma from '@/lib/prisma';
import { GET } from '../route';

jest.mock('@/lib/prisma', () => ({ __esModule: true, default: { $transaction: jest.fn() } }));

jest.mock('@/lib/cronAuth', () => ({ withCron: (handler: () => unknown) => handler }));
jest.mock('@/lib/attendance/nightlyClose', () => ({ duringNightlyRun: (run: () => unknown) => run() }));
jest.mock('@/lib/attendance/close', () => ({ executePendingCloses: jest.fn(), logCloseDepartures: jest.fn() }));
jest.mock('@/lib/attendanceTransitions', () => ({ processVisitCheckout: jest.fn().mockResolvedValue([]) }));
jest.mock('@/lib/specTrace', () => ({ traceOnCommit: (run: () => unknown) => run() }));
jest.mock('@/lib/postEventEmails', () => ({ processPostEventEmails: jest.fn().mockResolvedValue({}) }));
jest.mock('@/lib/membership/personAgreementTriggers', () => ({
    runPersonAgreementSweep: jest.fn().mockResolvedValue({ opened: 0 }),
}));
jest.mock('@/lib/problems', () => ({ sendProblemsDigest: jest.fn() }));
jest.mock('@/lib/facilityLock', () => ({ lockFacility: jest.fn() }));
jest.mock('@/lib/getFullAttendance', () => ({ invalidateAttendanceCache: jest.fn() }));

const EXPLICIT = { maxWait: 5_000, timeout: 15_000 };

function makeTx() {
    return {
        facilityClose: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({ id: 1 }) },
        visit: { findMany: jest.fn().mockResolvedValue([{ id: 7, personId: 3, departedAt: null, departedVia: null, person: {} }]) },
        $executeRaw: jest.fn(),
        $queryRaw: jest.fn().mockResolvedValue([]),
        auditLog: { createMany: jest.fn() },
    };
}

describe('nightly cron transactions', () => {
    it('run the sweep read, each visit checkout, and the date-of-birth purge with the explicit timeout', async () => {
        const runs: { tx: ReturnType<typeof makeTx>; options: unknown }[] = [];
        jest.mocked(prisma.$transaction).mockImplementation(((fn: (t: ReturnType<typeof makeTx>) => unknown, options: unknown) => {
            const tx = makeTx();
            runs.push({ tx, options });
            return fn(tx);
        }) as never);

        await GET(new Request('http://localhost/api/cron/nightly'));

        const sweep = runs.filter(({ tx }) => tx.visit.findMany.mock.calls.length > 0);
        const checkout = runs.filter(({ tx }) => tx.$executeRaw.mock.calls.length > 0);
        const purge = runs.filter(({ tx }) => tx.$queryRaw.mock.calls.length > 0);
        expect([sweep.length, checkout.length, purge.length]).toEqual([1, 1, 1]);
        for (const { options } of [...sweep, ...checkout, ...purge]) {
            expect(options).toEqual(EXPLICIT);
        }
    });
});
