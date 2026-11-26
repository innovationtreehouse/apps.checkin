/**
 * @jest-environment node
 */
/** Which abandoned keyholders the nightly force-close notice names. */
import type { Prisma } from '@/generated/prisma/client';
import prisma from '@/lib/prisma';
import { GET } from '../route';

jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: { $transaction: jest.fn(), person: { findMany: jest.fn() }, auditLog: { create: jest.fn() } },
}));
jest.mock('@/lib/cronAuth', () => ({ withCron: (handler: () => unknown) => handler }));
jest.mock('@/lib/attendance/nightlyClose', () => ({ duringNightlyRun: (run: () => unknown) => run() }));
jest.mock('@/lib/attendance/close', () => ({ executePendingCloses: jest.fn(), logCloseDepartures: jest.fn() }));
jest.mock('@/lib/attendanceTransitions', () => ({
    processVisitCheckout: jest.fn().mockResolvedValue([{ departedAt: new Date(), departedVia: 'NIGHTLY_SWEEP' }]),
}));
jest.mock('@/lib/specTrace', () => ({ traceOnCommit: (run: () => unknown) => run() }));
jest.mock('@/lib/postEventEmails', () => ({ processPostEventEmails: jest.fn().mockResolvedValue({}) }));
jest.mock('@/lib/membership/personAgreementTriggers', () => ({
    runPersonAgreementSweep: jest.fn().mockResolvedValue({ opened: 0, failed: 0, yearStart: '' }),
}));
jest.mock('@/lib/problems', () => ({ sendProblemsDigest: jest.fn() }));
jest.mock('@/lib/facilityLock', () => ({ lockFacility: jest.fn() }));
jest.mock('@/lib/getFullAttendance', () => ({ invalidateAttendanceCache: jest.fn() }));

const HOUSEHOLD_STATUS: Record<number, string> = { 1: 'ACTIVE', 2: 'REVOKED', 3: 'DENIED' };
const NAME: Record<number, string> = { 1: 'Active Keyholder', 2: 'Revoked Keyholder', 3: 'Denied Keyholder' };

/** Applies the id list and the household-status exclusion the keyholder query carries; the board query finds no one. */
function personFindMany(args: { where: Prisma.PersonWhereInput }) {
    if (!args.where.id) return Promise.resolve([]);
    const ids = (args.where.id as { in: number[] }).in;
    const voided = (args.where.NOT as { household: { orgMembership: { status: { in: string[] } } } })
        .household.orgMembership.status.in;
    const people = ids.filter(id => args.where.isKeyholder === true && !voided.includes(HOUSEHOLD_STATUS[id]));
    return Promise.resolve(people.map(id => ({ id })));
}

function makeTx() {
    return {
        facilityClose: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({ id: 1 }) },
        visit: {
            findMany: jest.fn().mockResolvedValue([1, 2, 3].map(id => ({
                id: 10 + id, personId: id, departedAt: null, departedVia: null,
                person: { id, name: NAME[id], email: `k${id}@example.com`, isKeyholder: true },
            }))),
        },
        $executeRaw: jest.fn(),
        $queryRaw: jest.fn().mockResolvedValue([]),
        auditLog: { createMany: jest.fn() },
    };
}

it('names an ACTIVE household keyholder and not a REVOKED or DENIED one', async () => {
    jest.mocked(prisma.$transaction).mockImplementation(((fn: (t: ReturnType<typeof makeTx>) => unknown) => fn(makeTx())) as never);
    jest.mocked(prisma.person.findMany).mockImplementation(personFindMany as never);
    jest.spyOn(console, 'info').mockImplementation(() => {});

    await GET(new Request('http://localhost/api/cron/nightly'));

    const notice = JSON.stringify(jest.mocked(prisma.auditLog.create).mock.calls[0][0].data.newData);
    expect(/Abandoned keyholders: ([^.]*)\./.exec(notice)?.[1]).toBe('Active Keyholder');
});
