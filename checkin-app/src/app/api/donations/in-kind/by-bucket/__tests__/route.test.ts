/**
 * @jest-environment node
 */
/**
 * GET /api/donations/in-kind/by-bucket: finance and the board see every bucket; a program
 * approver sees only the buckets they approve. The library's factory is mocked; its query is
 * covered in packages/bulk-donation's accept-step integration tests.
 */
import type { NextRequest } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { routes } from '@checkin/bulk-donation';
import { GET } from '../route';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));
jest.mock('@checkin/bulk-donation', () => ({
    routes: { inKind: { listByBucket: jest.fn(() => async () => ({ InKindBucketGiftView: [] })) } },
}));

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
    beforeEach(() => jest.clearAllMocks());

    it.each([{ isFinance: true }, { isBoardMember: true }])('shows %p every bucket', async (flags) => {
        signIn(flags);
        expect((await get()).status).toBe(200);
        expect(routes.inKind.listByBucket).toHaveBeenCalledWith(true);
    });

    it("limits a program leader to the buckets they approve", async () => {
        signIn({ programsLed: [4] });
        expect((await get()).status).toBe(200);
        expect(routes.inKind.listByBucket).toHaveBeenCalledWith(false);
    });
});
