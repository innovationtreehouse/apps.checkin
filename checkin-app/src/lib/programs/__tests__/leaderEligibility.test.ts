/**
 * @jest-environment node
 */
import { leaderIneligibilities, leaderIneligibilityReason } from '@/lib/programs/leaderEligibility';
import { checkValidFor, loadCheckReviews } from '@/lib/membership/checkStanding';
import type { DbClient } from '@/lib/db-client';

jest.mock('@/lib/membership/checkStanding', () => ({
    ...jest.requireActual('@/lib/membership/checkStanding'),
    checkValidFor: jest.fn(),
    loadCheckReviews: jest.fn(),
}));

const db = {} as DbClient;

const window = new Date('2099-01-01');

describe('leaderIneligibilityReason', () => {
    it('admits a cleared ACTIVE member', () => {
        expect(leaderIneligibilityReason(true, 'CLEARED', window)).toBeNull();
    });

    it('names the membership first, then the clearance', () => {
        expect(leaderIneligibilityReason(false, 'CLEARED', window)).toMatch(/active Treehouse Membership/);
        for (const standing of ['NONE', 'PENDING', 'DISPUTED'] as const) {
            expect(leaderIneligibilityReason(true, standing, window)).toMatch(/background-check clearance/);
        }
    });

    it('tells the Board to set the interval while none is set', () => {
        expect(leaderIneligibilityReason(true, 'NONE', null)).toMatch(/Board must set the background-check interval/);
    });
});

describe('leaderIneligibilities', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        (checkValidFor as jest.Mock).mockResolvedValue(new Date('2099-01-01'));
        (loadCheckReviews as jest.Mock).mockImplementation(async (_db: unknown, ids: number[]) => new Map(ids.map((id) => [id, []])));
    });

    it('gives each person the reason the single check would give', async () => {
        const reasons = await leaderIneligibilities(db, [
            { id: 1, isMember: true, lastBackgroundCheck: new Date('2099-06-01') },
            { id: 2, isMember: false, lastBackgroundCheck: new Date('2099-06-01') },
            { id: 3, isMember: true, lastBackgroundCheck: new Date('2098-01-01') },
        ], 2099);
        expect(checkValidFor).toHaveBeenCalledWith(2099, db);
        expect(reasons.get(1)).toBeNull();
        expect(reasons.get(2)).toMatch(/active Treehouse Membership/);
        expect(reasons.get(3)).toMatch(/background-check clearance/);
    });

    it('reads nothing for nobody', async () => {
        expect((await leaderIneligibilities(db, [], 2099)).size).toBe(0);
        expect(checkValidFor).not.toHaveBeenCalled();
    });
});
