/**
 * @jest-environment node
 */
import { leaderIneligibilities, leaderIneligibilityReason } from '@/lib/programs/leaderEligibility';
import { liveBgThreshold, loadCheckReviews } from '@/lib/membership/checkStanding';
import type { DbClient } from '@/lib/db-client';

jest.mock('@/lib/membership/checkStanding', () => ({
    ...jest.requireActual('@/lib/membership/checkStanding'),
    liveBgThreshold: jest.fn(),
    loadCheckReviews: jest.fn(),
}));

const db = {} as DbClient;

describe('leaderIneligibilityReason', () => {
    it('admits a cleared ACTIVE member', () => {
        expect(leaderIneligibilityReason(true, 'CLEARED')).toBeNull();
    });

    it('names the membership first, then the clearance', () => {
        expect(leaderIneligibilityReason(false, 'CLEARED')).toMatch(/active Treehouse Membership/);
        for (const standing of ['NONE', 'PENDING', 'DISPUTED'] as const) {
            expect(leaderIneligibilityReason(true, standing)).toMatch(/background-check clearance/);
        }
    });
});

describe('leaderIneligibilities', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        (liveBgThreshold as jest.Mock).mockResolvedValue(new Date('2099-01-01'));
        (loadCheckReviews as jest.Mock).mockImplementation(async (_db: unknown, ids: number[]) => new Map(ids.map((id) => [id, []])));
    });

    it('gives each person the reason the single check would give', async () => {
        const reasons = await leaderIneligibilities(db, [
            { id: 1, isMember: true, lastBackgroundCheck: new Date('2099-06-01') },
            { id: 2, isMember: false, lastBackgroundCheck: new Date('2099-06-01') },
            { id: 3, isMember: true, lastBackgroundCheck: new Date('2098-01-01') },
        ]);
        expect(reasons.get(1)).toBeNull();
        expect(reasons.get(2)).toMatch(/active Treehouse Membership/);
        expect(reasons.get(3)).toMatch(/background-check clearance/);
    });

    it('reads nothing for nobody', async () => {
        expect((await leaderIneligibilities(db, [])).size).toBe(0);
        expect(liveBgThreshold).not.toHaveBeenCalled();
    });
});
