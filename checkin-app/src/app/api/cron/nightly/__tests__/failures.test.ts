/**
 * @jest-environment node
 */
/** What the nightly run reports when a checkout or an agreement open fails. */
import prisma from '@/lib/prisma';
import { processVisitCheckout } from '@/lib/attendanceTransitions';
import { runPersonAgreementSweep } from '@/lib/membership/personAgreementTriggers';
import { sendProblemsDigest } from '@/lib/problems';
import { inRun, newRun } from '@/lib/finishRun';
import { GET } from '../route';

jest.mock('@/lib/prisma', () => ({ __esModule: true, default: { $transaction: jest.fn() } }));

jest.mock('@/lib/cronAuth', () => ({ withCron: (handler: () => unknown) => handler }));
jest.mock('@/lib/attendance/nightlyClose', () => ({ duringNightlyRun: (run: () => unknown) => run() }));
jest.mock('@/lib/attendance/close', () => ({ executePendingCloses: jest.fn(), logCloseDepartures: jest.fn() }));
jest.mock('@/lib/attendanceTransitions', () => ({ processVisitCheckout: jest.fn() }));
jest.mock('@/lib/specTrace', () => ({ traceOnCommit: (run: () => unknown) => run() }));
jest.mock('@/lib/postEventEmails', () => ({ processPostEventEmails: jest.fn().mockResolvedValue({}) }));
jest.mock('@/lib/membership/personAgreementTriggers', () => ({ runPersonAgreementSweep: jest.fn() }));
jest.mock('@/lib/problems', () => ({ sendProblemsDigest: jest.fn() }));
jest.mock('@/lib/facilityLock', () => ({ lockFacility: jest.fn() }));
jest.mock('@/lib/getFullAttendance', () => ({ invalidateAttendanceCache: jest.fn() }));

const EMAIL = 'member@example.com';

function makeTx() {
    return {
        facilityClose: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({ id: 1 }) },
        visit: {
            findMany: jest.fn().mockResolvedValue([
                { id: 7, personId: 3, departedAt: null, departedVia: null, person: { email: EMAIL, isKeyholder: false } },
            ]),
        },
        $executeRaw: jest.fn(),
        $queryRaw: jest.fn().mockResolvedValue([]),
        auditLog: { createMany: jest.fn() },
    };
}

describe('nightly cron failures', () => {
    it('logs a failed checkout by person id, not email, and counts agreement failures', async () => {
        jest.mocked(prisma.$transaction).mockImplementation(((fn: (t: ReturnType<typeof makeTx>) => unknown) => fn(makeTx())) as never);
        jest.mocked(processVisitCheckout).mockRejectedValue(new Error('lock timeout'));
        jest.mocked(runPersonAgreementSweep).mockResolvedValue({ opened: 0, failed: 2, closedAtYearEnd: 0, closeFailed: 0, yearStart: '' });
        const errors = jest.spyOn(console, 'error').mockImplementation(() => {});

        const res = await GET(new Request('http://localhost/api/cron/nightly'));

        const logged = errors.mock.calls.map(([message]) => String(message));
        expect(logged).toEqual([expect.stringContaining('(person 3)')]);
        expect(logged.join('\n')).not.toContain(EMAIL);
        expect((await res.json()).failed).toBe(3);
    });

    it('closes the other visits when one checkout throws, records the failure on the run, and emails it tonight', async () => {
        const tx = makeTx();
        tx.visit.findMany.mockResolvedValue([
            { id: 7, personId: 3, departedAt: null, departedVia: null, person: { email: EMAIL, isKeyholder: false } },
            { id: 8, personId: 4, departedAt: null, departedVia: null, person: { email: 'b@example.com', isKeyholder: false } },
        ]);
        jest.mocked(prisma.$transaction).mockImplementation(((fn: (t: ReturnType<typeof makeTx>) => unknown) => fn(tx)) as never);
        jest.mocked(processVisitCheckout).mockReset()
            .mockRejectedValueOnce(new Error('lock timeout'))
            .mockResolvedValueOnce([]);
        jest.mocked(runPersonAgreementSweep).mockResolvedValue({ opened: 0, failed: 0, closedAtYearEnd: 0, closeFailed: 0, yearStart: '' });
        jest.spyOn(console, 'error').mockImplementation(() => {});
        const run = newRun();

        const res = await inRun(run, () => GET(new Request('http://localhost/api/cron/nightly')));

        expect(jest.mocked(processVisitCheckout).mock.calls.map(([visitId]) => visitId)).toEqual([7, 8]);
        expect((await res.json()).failed).toBe(1);
        expect(run.reports).toEqual([{ lane: 'attendance nightly-close', kind: 'bug', detail: 'visit 7, person 3' }]);
        expect(jest.mocked(sendProblemsDigest).mock.calls.at(-1)?.[1]).toEqual([expect.stringContaining('visit 7, person 3')]);
    });
});
