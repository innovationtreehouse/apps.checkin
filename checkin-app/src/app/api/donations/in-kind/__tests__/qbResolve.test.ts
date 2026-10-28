/**
 * @jest-environment node
 */
/**
 * POST /api/donations/in-kind/{receipt,manual}/[id]/qb-resolve (book, skip, match, clear): FINANCE only, replying with the gift's queue row and no donor.
 * The library's route factory is mocked; the actions are covered in packages/bulk-donation's in-kind drain integration tests.
 */
import type { NextRequest } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { routes } from '@checkin/bulk-donation';
import { POST as resolveReceipt } from '../receipt/[id]/qb-resolve/route';
import { POST as resolveManual } from '../manual/[id]/qb-resolve/route';

const mockResolve = jest.fn();
jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));
// Each route calls qbResolve(source) at module load; the handler it returns reads mockResolve per request.
jest.mock('@checkin/bulk-donation', () => ({
    routes: { inKind: { qbResolve: jest.fn((source: string) => (...args: unknown[]) => mockResolve(source, ...args)) } },
}));

type Flags = { isFinance?: boolean; isBoardMember?: boolean; isSysadmin?: boolean; isOperations?: boolean; isInventoryManager?: boolean };

// canAccessStaging and the cookie get a browser session past the stg gate and local's keyless-kiosk path.
const signIn = (flags: Flags) =>
    (getServerSession as jest.Mock).mockResolvedValue({
        user: { id: 7, isSysadmin: false, isBoardMember: false, isFinance: false, canAccessStaging: true, ...flags },
    });

const post = (route: typeof resolveReceipt, body: unknown) =>
    route(
        new Request('http://localhost/api/donations/in-kind/x/4/qb-resolve', {
            method: 'POST',
            headers: { cookie: 'next-auth.session-token=x', 'content-type': 'application/json' },
            body: JSON.stringify(body),
        }) as unknown as NextRequest,
        { params: Promise.resolve({ id: '4' }) },
    );

const ITEM = {
    id: 4,
    source: 'manual',
    state: null,
    waitingOn: [],
    revenueBooking: null,
    expenseBooking: null,
    qbState: 'DISMISSED',
    qbNote: null,
    lines: [],
};

beforeEach(() => {
    mockResolve.mockReset();
    mockResolve.mockResolvedValue({ InKindQueueItemView: { ...ITEM, donorLastName: 'Giver', orgId: 'treehouse' } });
});

describe('in-kind qb-resolve routes', () => {
    it('mounts one factory per source', () => {
        expect(jest.mocked(routes.inKind.qbResolve).mock.calls.map(([source]) => source).sort()).toEqual(['manual', 'receipt']);
    });

    it.each([
        { action: 'book' },
        { action: 'skip', reason: 'Booked by hand' },
        { action: 'match', journalEntryId: '88' },
        { action: 'match', depositId: '51', purchaseId: '52' },
        { action: 'clear', reason: 'Voided the stray entry' },
    ])('replies to finance with the queue row and no donor: %p', async body => {
        signIn({ isFinance: true });
        for (const [route, source] of [[resolveReceipt, 'receipt'], [resolveManual, 'manual']] as const) {
            const res = await post(route, body);
            expect(res.status).toBe(200);
            expect(await res.json()).toEqual(ITEM);
            expect(mockResolve).toHaveBeenLastCalledWith(source, expect.anything());
        }
    });

    it.each([{ isBoardMember: true }, { isSysadmin: true }, { isOperations: true }, { isInventoryManager: true }, {}])(
        'refuses %p with 403 without reaching the library',
        async flags => {
            signIn(flags);
            for (const route of [resolveReceipt, resolveManual]) expect((await post(route, { action: 'book' })).status).toBe(403);
            expect(mockResolve).not.toHaveBeenCalled();
        },
    );

    it('refuses no session with 401', async () => {
        (getServerSession as jest.Mock).mockResolvedValue(null);
        expect((await post(resolveReceipt, { action: 'book' })).status).toBe(401);
        expect(mockResolve).not.toHaveBeenCalled();
    });
});
