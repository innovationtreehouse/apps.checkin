/**
 * @jest-environment node
 */
/**
 * GET /api/donations/in-kind/queue: FINANCE or BOARD, and the rows carry only the queue fields. The library's
 * route factory is mocked; its query is covered in packages/bulk-donation's in-kind integration tests.
 */
import type { NextRequest } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { routes } from '@checkin/bulk-donation';
import { GET } from '../route';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));
jest.mock('@checkin/bulk-donation', () => ({
    routes: { inKind: { listQueue: jest.fn() } },
}));

type Flags = { isFinance?: boolean; isBoardMember?: boolean; isSysadmin?: boolean; isOperations?: boolean; isInventoryManager?: boolean };

// canAccessStaging and the cookie get a browser session past the stg gate and local's keyless-kiosk path.
const signIn = (flags: Flags) =>
    (getServerSession as jest.Mock).mockResolvedValue({
        user: { id: 7, isSysadmin: false, isBoardMember: false, isFinance: false, canAccessStaging: true, ...flags },
    });

const get = () =>
    GET(
        new Request('http://localhost/api/donations/in-kind/queue', {
            headers: { cookie: 'next-auth.session-token=x' },
        }) as unknown as NextRequest,
        { params: Promise.resolve({}) },
    );

const DONOR_NEEDED = {
    id: 1,
    receiptId: 'r-1',
    receiptTotalCents: 2500,
    receiptDate: '2026-10-01',
    moneyReceivedAt: '2026-10-02T12:00:00.000Z',
    donorRecordedAt: null,
    withdrawnAfterMoneyAt: null,
};
const WITHDRAWN = {
    ...DONOR_NEEDED,
    id: 2,
    receiptId: 'r-2',
    donorRecordedAt: '2026-10-02T12:05:00.000Z',
    withdrawnAfterMoneyAt: '2026-10-03T09:00:00.000Z',
};

describe('GET /api/donations/in-kind/queue', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        jest.mocked(routes.inKind.listQueue).mockResolvedValue({ InKindQueueItemView: [DONOR_NEEDED, WITHDRAWN] });
    });

    it.each([{ isFinance: true }, { isBoardMember: true }])('returns the queue as a bare array to %p', async (flags) => {
        signIn(flags);
        const res = await get();
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual([DONOR_NEEDED, WITHDRAWN]);
    });

    it('strips any field outside the queue view, such as a donor name', async () => {
        jest.mocked(routes.inKind.listQueue).mockResolvedValue({
            InKindQueueItemView: [{ ...WITHDRAWN, donorFirstName: 'Pat', donorLastName: 'Doe', donorCompanyName: 'Acme' }],
        });
        signIn({ isFinance: true });
        expect(await (await get()).json()).toEqual([WITHDRAWN]);
    });

    it.each([{ isSysadmin: true }, { isOperations: true }, { isInventoryManager: true }, {}])(
        'refuses %p with 403 without reaching the library',
        async (flags) => {
            signIn(flags);
            expect((await get()).status).toBe(403);
            expect(routes.inKind.listQueue).not.toHaveBeenCalled();
        },
    );

    it('refuses no session with 401', async () => {
        (getServerSession as jest.Mock).mockResolvedValue(null);
        expect((await get()).status).toBe(401);
        expect(routes.inKind.listQueue).not.toHaveBeenCalled();
    });
});
