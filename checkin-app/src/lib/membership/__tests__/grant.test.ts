/**
 * @jest-environment node
 */
import prisma from '@/lib/prisma';
import { grantMembership, grantMessage, refuseGrantIfDenied, type GrantResult } from '@/lib/membership/grant';
import { raiseDeniedHouseholdActivity } from '@/lib/membership/householdStatus';
import { createRenewalProcess } from '@/lib/membership/renewal';
import { certifyPaymentPlan, liveYearVariantId } from '@/lib/membership/payment';

jest.mock('@/lib/prisma', () => {
    const db = {
        orgMembership: { findUnique: jest.fn(), findUniqueOrThrow: jest.fn(), createMany: jest.fn() },
        orgMembershipProcess: { findFirst: jest.fn(), findMany: jest.fn(), findUniqueOrThrow: jest.fn(), create: jest.fn() },
        boardSettings: { findUnique: jest.fn() },
        auditLog: { create: jest.fn() },
        $queryRaw: jest.fn(),
        $transaction: jest.fn((fn: (tx: unknown) => unknown): unknown => fn(db)),
    };
    return { __esModule: true, default: db };
});
jest.mock('@/lib/membership/renewal', () => ({
    ...jest.requireActual('@/lib/membership/renewal'),
    createRenewalProcess: jest.fn(),
}));
jest.mock('@/lib/membership/payment', () => ({
    ...jest.requireActual('@/lib/membership/payment'),
    certifyPaymentPlan: jest.fn().mockResolvedValue(undefined),
    liveYearVariantId: jest.fn(),
}));
jest.mock('@/lib/membership/householdStatus', () => ({
    ...jest.requireActual('@/lib/membership/householdStatus'),
    raiseDeniedHouseholdActivity: jest.fn().mockResolvedValue(undefined),
}));

const findUnique = jest.mocked(prisma.orgMembership.findUnique);
const raise = jest.mocked(raiseDeniedHouseholdActivity);

describe('refuseGrantIfDenied', () => {
    beforeEach(() => jest.clearAllMocks());

    it('refuses a DENIED household without raising it to the board', async () => {
        findUnique.mockResolvedValue({ status: 'DENIED' } as Awaited<ReturnType<typeof prisma.orgMembership.findUnique>>);
        await expect(refuseGrantIfDenied(7)).rejects.toThrow('This household is denied. Restore it before granting membership.');
        expect(raise).not.toHaveBeenCalled();
    });

    it.each(['NONE', 'ACTIVE', 'REVOKED'] as const)('lets a %s household through', async (status) => {
        findUnique.mockResolvedValue({ status } as Awaited<ReturnType<typeof prisma.orgMembership.findUnique>>);
        await expect(refuseGrantIfDenied(7)).resolves.toBeUndefined();
        expect(raise).not.toHaveBeenCalled();
    });

    it('lets a household with no membership row through', async () => {
        findUnique.mockResolvedValue(null);
        await expect(refuseGrantIfDenied(7)).resolves.toBeUndefined();
    });
});

describe('grantMembership opening an application', () => {
    beforeEach(() => jest.clearAllMocks());

    it('refuses when a deny lands between the pre-check and the row lock', async () => {
        findUnique.mockResolvedValue({ status: 'NONE' } as Awaited<ReturnType<typeof prisma.orgMembership.findUnique>>);
        jest.mocked(prisma.orgMembership.findUniqueOrThrow).mockResolvedValue({ id: 3, status: 'NONE' } as Awaited<ReturnType<typeof prisma.orgMembership.findUniqueOrThrow>>);
        jest.mocked(prisma.orgMembershipProcess.findFirst).mockResolvedValue(null);
        jest.mocked(prisma.$queryRaw).mockResolvedValue([{ status: 'DENIED' }]);

        await expect(grantMembership(7, { actorId: 99, reason: 'comp' }, 2026)).rejects.toThrow('This household is denied. Restore it before granting membership.');
        expect(prisma.orgMembershipProcess.create).not.toHaveBeenCalled();
        expect(raise).not.toHaveBeenCalled();
    });

    it('refuses when the household has a BLOCKED application, without opening a new one', async () => {
        findUnique.mockResolvedValue({ status: 'NONE' } as Awaited<ReturnType<typeof prisma.orgMembership.findUnique>>);
        jest.mocked(prisma.orgMembership.findUniqueOrThrow).mockResolvedValue({ id: 3, status: 'NONE' } as Awaited<ReturnType<typeof prisma.orgMembership.findUniqueOrThrow>>);
        jest.mocked(prisma.orgMembershipProcess.findFirst).mockResolvedValue(null);
        jest.mocked(prisma.$queryRaw).mockResolvedValue([{ status: 'NONE' }]);
        jest.mocked(prisma.orgMembershipProcess.findMany).mockResolvedValue([
            { id: 11, kind: 'INITIAL', status: 'BLOCKED' },
        ] as Awaited<ReturnType<typeof prisma.orgMembershipProcess.findMany>>);

        await expect(grantMembership(7, { actorId: 99, reason: 'comp' }, 2026)).rejects.toThrow(/blocked application/);
        expect(prisma.orgMembershipProcess.create).not.toHaveBeenCalled();
        expect(prisma.orgMembershipProcess.findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({ orgMembershipId: 3, OR: expect.arrayContaining([expect.objectContaining({ status: 'BLOCKED' })]) }),
        }));
    });

    it('refuses when the household went ACTIVE between the pre-check and the row lock', async () => {
        findUnique.mockResolvedValue({ status: 'NONE' } as Awaited<ReturnType<typeof prisma.orgMembership.findUnique>>);
        jest.mocked(prisma.orgMembership.findUniqueOrThrow).mockResolvedValue({ id: 3, status: 'NONE' } as Awaited<ReturnType<typeof prisma.orgMembership.findUniqueOrThrow>>);
        jest.mocked(prisma.orgMembershipProcess.findFirst).mockResolvedValue(null);
        jest.mocked(prisma.$queryRaw).mockResolvedValue([{ status: 'ACTIVE' }]);
        jest.mocked(prisma.orgMembershipProcess.findMany).mockResolvedValue([]);

        await expect(grantMembership(7, { actorId: 99, reason: 'comp' }, 2026)).rejects.toThrow(/already an active member/);
        expect(prisma.orgMembershipProcess.create).not.toHaveBeenCalled();
    });

    it('opens an INITIAL application when nothing is open or blocked', async () => {
        findUnique.mockResolvedValue({ status: 'NONE' } as Awaited<ReturnType<typeof prisma.orgMembership.findUnique>>);
        jest.mocked(prisma.orgMembership.findUniqueOrThrow).mockResolvedValue({ id: 3, status: 'NONE' } as Awaited<ReturnType<typeof prisma.orgMembership.findUniqueOrThrow>>);
        jest.mocked(prisma.orgMembershipProcess.findFirst).mockResolvedValue(null);
        jest.mocked(prisma.$queryRaw).mockResolvedValue([{ status: 'NONE' }]);
        jest.mocked(prisma.orgMembershipProcess.findMany).mockResolvedValue([]);
        jest.mocked(prisma.orgMembershipProcess.create).mockResolvedValue({ id: 12, kind: 'INITIAL', status: 'INTAKE' } as Awaited<ReturnType<typeof prisma.orgMembershipProcess.create>>);

        await expect(grantMembership(7, { actorId: 99, reason: 'comp' }, 2026)).resolves.toMatchObject({ paid: false, opened: true });
    });
});

describe('grantMembership on a lapsed ACTIVE household with nothing open', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        findUnique.mockResolvedValue({ status: 'ACTIVE' } as Awaited<ReturnType<typeof prisma.orgMembership.findUnique>>);
        jest.mocked(prisma.orgMembership.findUniqueOrThrow).mockResolvedValue({ id: 3, status: 'ACTIVE' } as Awaited<ReturnType<typeof prisma.orgMembership.findUniqueOrThrow>>);
        jest.mocked(prisma.boardSettings.findUnique).mockResolvedValue({ orgMembershipYearBoundary: new Date(Date.UTC(2000, 7, 1)) } as Awaited<ReturnType<typeof prisma.boardSettings.findUnique>>);
        jest.mocked(liveYearVariantId).mockResolvedValue('gid://variant/live');
    });

    it('opens a renewal for the family to complete, whatever the season', async () => {
        jest.mocked(prisma.orgMembershipProcess.findFirst)
            .mockResolvedValueOnce(null) // nothing in flight
            .mockResolvedValueOnce(null); // not paid for the live year
        jest.mocked(createRenewalProcess).mockResolvedValue({ id: 30, kind: 'RENEWAL', status: 'PENDING_RENEWAL' } as Awaited<ReturnType<typeof createRenewalProcess>>);

        await expect(grantMembership(7, { actorId: 99, reason: 'check' }, 2026)).resolves.toMatchObject({ paid: false, opened: true, process: { id: 30 } });
        expect(createRenewalProcess).toHaveBeenCalledWith(3);
    });

    it('refuses to open a renewal while the live year has no store product', async () => {
        jest.useFakeTimers({ now: new Date(Date.UTC(2026, 9, 1)), doNotFake: ['nextTick', 'setImmediate'] });
        try {
            jest.mocked(prisma.orgMembershipProcess.findFirst)
                .mockResolvedValueOnce(null)
                .mockResolvedValueOnce(null);
            jest.mocked(liveYearVariantId).mockResolvedValue(null);

            await expect(grantMembership(7, { actorId: 99, reason: 'check' }, 2026)).rejects.toThrow(
                "No membership product is set for 2026-2027, so the family couldn't pay. Set it in membership settings before opening a renewal.",
            );
            expect(createRenewalProcess).not.toHaveBeenCalled();
        } finally {
            jest.useRealTimers();
        }
    });

    it('refuses a household already paid for the live year', async () => {
        jest.mocked(prisma.orgMembershipProcess.findFirst)
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ id: 31 } as Awaited<ReturnType<typeof prisma.orgMembershipProcess.findFirst>>);

        await expect(grantMembership(7, { actorId: 99, reason: 'check' }, 2026)).rejects.toThrow(/already paid for the current membership year/);
        expect(createRenewalProcess).not.toHaveBeenCalled();
    });
});

describe('grantMembership on an application already in flight', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        findUnique.mockResolvedValue({ status: 'ACTIVE' } as Awaited<ReturnType<typeof prisma.orgMembership.findUnique>>);
        jest.mocked(prisma.orgMembership.findUniqueOrThrow).mockResolvedValue({ id: 3, status: 'ACTIVE' } as Awaited<ReturnType<typeof prisma.orgMembership.findUniqueOrThrow>>);
    });

    it('maps a payment onto a PENDING_PAYMENT application even while the year has no store product', async () => {
        jest.mocked(liveYearVariantId).mockResolvedValue(null);
        jest.mocked(prisma.orgMembershipProcess.findFirst).mockResolvedValue({ id: 40, kind: 'RENEWAL', status: 'PENDING_PAYMENT' } as Awaited<ReturnType<typeof prisma.orgMembershipProcess.findFirst>>);
        jest.mocked(prisma.orgMembershipProcess.findUniqueOrThrow).mockResolvedValue({ id: 40, kind: 'RENEWAL', status: 'ACTIVE' } as Awaited<ReturnType<typeof prisma.orgMembershipProcess.findUniqueOrThrow>>);

        await expect(grantMembership(7, { actorId: 99, reason: 'paid cash' }, 2026)).resolves.toMatchObject({ paid: true, process: { id: 40 } });
        expect(certifyPaymentPlan).toHaveBeenCalledWith(40, 99, { reason: 'paid cash', year: 2026 });
        expect(createRenewalProcess).not.toHaveBeenCalled();
    });

    it('refuses an application at INTAKE, naming the step', async () => {
        jest.mocked(prisma.orgMembershipProcess.findFirst).mockResolvedValue({ id: 41, kind: 'INITIAL', status: 'INTAKE' } as Awaited<ReturnType<typeof prisma.orgMembershipProcess.findFirst>>);

        await expect(grantMembership(7, { actorId: 99, reason: 'comp' }, 2026)).rejects.toThrow(
            "The household's application is at INTAKE; it can be granted once it reaches payment.",
        );
        expect(certifyPaymentPlan).not.toHaveBeenCalled();
    });
});

describe('grantMessage', () => {
    const process = (kind: 'INITIAL' | 'RENEWAL', status: string) => ({ kind, status }) as GrantResult['process'];

    it('says Granted only when a payment was mapped', () => {
        expect(grantMessage({ paid: true, process: process('RENEWAL', 'ACTIVE') })).toBe('Granted: the membership is active.');
        expect(grantMessage({ paid: true, process: process('INITIAL', 'PENDING_BG_CLEARANCE') })).toBe('Granted: the membership activates once the background check clears.');
    });

    it('names an opened renewal or application, never Granted', () => {
        expect(grantMessage({ paid: false, opened: true, process: process('RENEWAL', 'PENDING_RENEWAL') })).toBe('Renewal opened: the family completes it, then grant once it reaches payment.');
        expect(grantMessage({ paid: false, opened: true, process: process('INITIAL', 'INTAKE') })).toBe('Application opened: the family completes it, then grant once it reaches payment.');
        expect(grantMessage({ paid: false, opened: false, process: process('INITIAL', 'INTAKE') })).toBe('Application already open: the family completes it, then grant once it reaches payment.');
    });
});
