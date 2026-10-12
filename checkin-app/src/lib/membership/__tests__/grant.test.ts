/**
 * @jest-environment node
 */
import prisma from '@/lib/prisma';
import { refuseGrantIfDenied } from '@/lib/membership/grant';
import { raiseDeniedHouseholdActivity } from '@/lib/membership/householdStatus';
import { PaymentError } from '@/lib/membership/payment';

jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: { orgMembership: { findUnique: jest.fn() } },
}));
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
