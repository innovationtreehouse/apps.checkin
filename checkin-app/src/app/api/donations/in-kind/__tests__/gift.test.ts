/**
 * @jest-environment node
 */
/**
 * GET /api/donations/in-kind/{receipt,manual}/[id]: FINANCE or BOARD see the gift with its donor; ops is refused.
 * The library's route factory is mocked; its query is covered in packages/bulk-donation's in-kind integration tests.
 */
import type { NextRequest } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { routes } from '@checkin/bulk-donation';
import { GET as getReceiptGift } from '../receipt/[id]/route';
import { GET as getManualGift } from '../manual/[id]/route';

const mockGetGift = jest.fn();
jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));
// Each route calls getGift(source) at module load; the handler it returns reads mockGetGift per request.
jest.mock('@checkin/bulk-donation', () => ({
    routes: { inKind: { getGift: jest.fn(() => (...args: unknown[]) => mockGetGift(...args)) } },
}));

type Flags = { isFinance?: boolean; isBoardMember?: boolean; isOperations?: boolean; isInventoryManager?: boolean };

// canAccessStaging and the cookie get a browser session past the stg gate and local's keyless-kiosk path.
const signIn = (flags: Flags) =>
    (getServerSession as jest.Mock).mockResolvedValue({
        user: { id: 7, isSysadmin: false, isBoardMember: false, isFinance: false, canAccessStaging: true, ...flags },
    });

const call = (get: typeof getReceiptGift) =>
    get(
        new Request('http://localhost/api/donations/in-kind/x/4', { headers: { cookie: 'next-auth.session-token=x' } }) as unknown as NextRequest,
        { params: Promise.resolve({ id: '4' }) },
    );

const GIFT = {
    id: 4,
    source: 'manual',
    donorFirstName: 'Sam',
    donorLastName: 'Giver',
    donorCompanyName: null,
    inventorySourceKey: 'donation:4',
    lines: [{ id: 9, gtin13: '0011111111116', description: 'Drill', quantity: 2, valueCents: null, suggestedValueCents: 4000 }],
    events: [],
};

beforeEach(() => {
    mockGetGift.mockReset();
    mockGetGift.mockResolvedValue({ InKindGiftDetailView: { ...GIFT, orgId: 'treehouse' } });
});

describe('in-kind gift detail routes', () => {
    it('mounts one factory per source', () => {
        expect(jest.mocked(routes.inKind.getGift).mock.calls.map(([source]) => source).sort()).toEqual(['manual', 'receipt']);
    });

    it.each([{ isFinance: true }, { isBoardMember: true }])('shows %p the gift with its donor', async flags => {
        signIn(flags);
        for (const get of [getReceiptGift, getManualGift]) {
            const res = await call(get);
            expect(res.status).toBe(200);
            expect(await res.json()).toEqual(GIFT);
        }
    });

    it.each([{ isOperations: true }, { isInventoryManager: true }, {}])('refuses %p', async flags => {
        signIn(flags);
        for (const get of [getReceiptGift, getManualGift]) {
            expect((await call(get)).status).toBe(403);
        }
        expect(mockGetGift).not.toHaveBeenCalled();
    });
});
