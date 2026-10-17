/**
 * @jest-environment node
 */
import prisma from '@/lib/prisma';
import { grantCurrentYear, refuseGrantIfDenied } from '@/lib/membership/grant';
import { raiseDeniedHouseholdActivity } from '@/lib/membership/householdStatus';
import { PaymentError } from '@/lib/membership/payment';

jest.mock('@/lib/prisma', () => {
    const db = {
        orgMembership: { findUnique: jest.fn(), upsert: jest.fn() },
        orgMembershipProcess: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn() },
        auditLog: { create: jest.fn() },
        $queryRaw: jest.fn(),
        $transaction: jest.fn((fn: (tx: unknown) => unknown): unknown => fn(db)),
    };
    return { __esModule: true, default: db };
});
jest.mock('@/lib/membership/householdStatus', () => ({
    ...jest.requireActual('@/lib/membership/householdStatus'),
    raiseDeniedHouseholdActivity: jest.fn().mockResolvedValue(undefined),
}));

const findUnique = jest.mocked(prisma.orgMembership.findUnique);
const raise = jest.mocked(raiseDeniedHouseholdActivity);

describe('refuseGrantIfDenied (both grant branches call it first)', () => {
    beforeEach(() => jest.clearAllMocks());

    it('refuses a DENIED household and raises it to the board', async () => {
        findUnique.mockResolvedValue({ status: 'DENIED' } as Awaited<ReturnType<typeof prisma.orgMembership.findUnique>>);
        await expect(refuseGrantIfDenied(7, 99)).rejects.toBeInstanceOf(PaymentError);
        expect(raise).toHaveBeenCalledWith(expect.objectContaining({ householdId: 7 }));
    });

    it.each(['NONE', 'ACTIVE', 'REVOKED'] as const)('lets a %s household through', async (status) => {
        findUnique.mockResolvedValue({ status } as Awaited<ReturnType<typeof prisma.orgMembership.findUnique>>);
        await expect(refuseGrantIfDenied(7, 99)).resolves.toBeUndefined();
        expect(raise).not.toHaveBeenCalled();
    });

    it('lets a household with no membership row through', async () => {
        findUnique.mockResolvedValue(null);
        await expect(refuseGrantIfDenied(7, 99)).resolves.toBeUndefined();
    });
});

describe('grantCurrentYear opening an application', () => {
    beforeEach(() => jest.clearAllMocks());

    it('refuses when a deny lands between the pre-check and the row lock', async () => {
        findUnique.mockResolvedValue({ status: 'NONE' } as Awaited<ReturnType<typeof prisma.orgMembership.findUnique>>);
        jest.mocked(prisma.orgMembership.upsert).mockResolvedValue({ id: 3, status: 'NONE' } as Awaited<ReturnType<typeof prisma.orgMembership.upsert>>);
        jest.mocked(prisma.orgMembershipProcess.findFirst).mockResolvedValue(null);
        jest.mocked(prisma.$queryRaw).mockResolvedValue([{ status: 'DENIED' }]);

        await expect(grantCurrentYear(7, { actorId: 99, reason: 'comp' })).rejects.toBeInstanceOf(PaymentError);
        expect(prisma.orgMembershipProcess.create).not.toHaveBeenCalled();
        expect(raise).toHaveBeenCalledWith(expect.objectContaining({ householdId: 7 }));
    });

    it('refuses when the household has a BLOCKED application, without opening a new one', async () => {
        findUnique.mockResolvedValue({ status: 'NONE' } as Awaited<ReturnType<typeof prisma.orgMembership.findUnique>>);
        jest.mocked(prisma.orgMembership.upsert).mockResolvedValue({ id: 3, status: 'NONE' } as Awaited<ReturnType<typeof prisma.orgMembership.upsert>>);
        jest.mocked(prisma.orgMembershipProcess.findFirst).mockResolvedValue(null);
        jest.mocked(prisma.$queryRaw).mockResolvedValue([{ status: 'NONE' }]);
        jest.mocked(prisma.orgMembershipProcess.findMany).mockResolvedValue([
            { id: 11, kind: 'INITIAL', status: 'BLOCKED' },
        ] as Awaited<ReturnType<typeof prisma.orgMembershipProcess.findMany>>);

        await expect(grantCurrentYear(7, { actorId: 99, reason: 'comp' })).rejects.toThrow(/blocked application/);
        expect(prisma.orgMembershipProcess.create).not.toHaveBeenCalled();
        expect(prisma.orgMembershipProcess.findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({ orgMembershipId: 3, OR: expect.arrayContaining([expect.objectContaining({ status: 'BLOCKED' })]) }),
        }));
    });

    it('opens an INITIAL application when nothing is open or blocked', async () => {
        findUnique.mockResolvedValue({ status: 'NONE' } as Awaited<ReturnType<typeof prisma.orgMembership.findUnique>>);
        jest.mocked(prisma.orgMembership.upsert).mockResolvedValue({ id: 3, status: 'NONE' } as Awaited<ReturnType<typeof prisma.orgMembership.upsert>>);
        jest.mocked(prisma.orgMembershipProcess.findFirst).mockResolvedValue(null);
        jest.mocked(prisma.$queryRaw).mockResolvedValue([{ status: 'NONE' }]);
        jest.mocked(prisma.orgMembershipProcess.findMany).mockResolvedValue([]);
        jest.mocked(prisma.orgMembershipProcess.create).mockResolvedValue({ id: 12, kind: 'INITIAL', status: 'INTAKE' } as Awaited<ReturnType<typeof prisma.orgMembershipProcess.create>>);

        await expect(grantCurrentYear(7, { actorId: 99, reason: 'comp' })).resolves.toMatchObject({ paid: false, opened: true });
    });
});
