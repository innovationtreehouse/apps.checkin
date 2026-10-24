/**
 * @jest-environment node
 */
/**
 * GET /api/donations/in-kind/by-bucket: finance and the board see every bucket; a bucket
 * approver sees only the buckets they approve, and a program leader who approves none is refused. The library's factory is mocked; its query is
 * covered in packages/bulk-donation's accept-step integration tests.
 */
import type { NextRequest } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { routes } from '@checkin/bulk-donation';
import { bucketsApprovedBy } from '@/lib/finance/bucketApprovers';
import { GET } from '../route';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));
jest.mock('@checkin/bulk-donation', () => ({
    routes: { inKind: { listByBucket: jest.fn(() => async () => ({ InKindBucketGiftView: [] })) } },
}));
jest.mock('@/lib/finance/bucketApprovers', () => ({ bucketsApprovedBy: jest.fn() }));

type Flags = { isFinance?: boolean; isBoardMember?: boolean; programsLed?: number[] };

const signIn = (flags: Flags) =>
    (getServerSession as jest.Mock).mockResolvedValue({
        user: { id: 7, isSysadmin: false, isBoardMember: false, isFinance: false, canAccessStaging: true, ...flags },
    });

const get = () =>
    GET(
        new Request('http://localhost/api/donations/in-kind/by-bucket', { headers: { cookie: 'next-auth.session-token=x' } }) as unknown as NextRequest,
        { params: Promise.resolve({}) },
    );

describe('GET /api/donations/in-kind/by-bucket', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        jest.mocked(bucketsApprovedBy).mockResolvedValue([]);
    });

    it.each([{ isFinance: true }, { isBoardMember: true }])('shows %p every bucket', async (flags) => {
        signIn(flags);
        expect((await get()).status).toBe(200);
        expect(routes.inKind.listByBucket).toHaveBeenCalledWith(true);
    });

    it("limits a bucket approver to the buckets they approve", async () => {
        jest.mocked(bucketsApprovedBy).mockResolvedValue([4]);
        signIn({});
        expect((await get()).status).toBe(200);
        expect(routes.inKind.listByBucket).toHaveBeenCalledWith(false);
    });

    it("refuses a program leader who approves no bucket", async () => {
        signIn({ programsLed: [4] });
        expect((await get()).status).toBe(403);
        expect(routes.inKind.listByBucket).not.toHaveBeenCalled();
    });
});
