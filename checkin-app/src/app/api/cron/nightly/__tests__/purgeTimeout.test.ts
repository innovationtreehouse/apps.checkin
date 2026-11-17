/**
 * @jest-environment node
 */
/**
 * The nightly date-of-birth purge runs in one transaction with a bulk audit
 * write; after a large import it needs more than Prisma's 5-second default.
 */
import prisma from '@/lib/prisma';
import { GET } from '../route';

jest.mock('@/lib/prisma', () => ({ __esModule: true, default: { $transaction: jest.fn() } }));

jest.mock('@/lib/cronAuth', () => ({ withCron: (handler: () => unknown) => handler }));
jest.mock('@/lib/attendance/nightlyClose', () => ({ duringNightlyRun: (run: () => unknown) => run() }));
jest.mock('@/lib/attendance/close', () => ({ executePendingCloses: jest.fn(), logCloseDepartures: jest.fn() }));
jest.mock('@/lib/postEventEmails', () => ({ processPostEventEmails: jest.fn().mockResolvedValue({}) }));
jest.mock('@/lib/membership/personAgreementTriggers', () => ({
    runPersonAgreementSweep: jest.fn().mockResolvedValue({ opened: 0 }),
}));
jest.mock('@/lib/problems', () => ({ sendProblemsDigest: jest.fn() }));
jest.mock('@/lib/facilityLock', () => ({ lockFacility: jest.fn() }));
jest.mock('@/lib/getFullAttendance', () => ({ invalidateAttendanceCache: jest.fn() }));

describe('nightly cron: date-of-birth purge', () => {
    it('runs its transaction with the explicit 15-second timeout', async () => {
        const tx = {
            facilityClose: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({ id: 1 }) },
            visit: { findMany: jest.fn().mockResolvedValue([]) },
            $queryRaw: jest.fn().mockResolvedValue([]),
            auditLog: { createMany: jest.fn() },
        };
        const transaction = jest.mocked(prisma.$transaction);
        transaction.mockImplementation(((fn: (t: typeof tx) => unknown) => fn(tx)) as never);

        await GET(new Request('http://localhost/api/cron/nightly'));

        const purge = transaction.mock.calls.find(([fn]) => String(fn).includes('createMany'));
        expect(purge).toBeDefined();
        expect(purge?.[1]).toEqual({ maxWait: 5_000, timeout: 15_000 });
    });
});
