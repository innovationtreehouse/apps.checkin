/**
 * @jest-environment node
 */
/**
 * Admission for the mail-alias routes (1265_RECEIPT_MAIL_ALIASES.md §8, A2),
 * asserted on the registry entries in registry/receipt.ts: FINANCE and the
 * BOARD, with the same `everyones:pii` view, and nobody else.
 */
import type { NextRequest as NextRequestType } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { allRoutes, getRoute } from '@/security/core';
import { handler } from '@/security/handler';

const { NextRequest } = jest.requireActual<{ NextRequest: typeof NextRequestType }>('next/server');
const mockSession = getServerSession as jest.MockedFunction<typeof getServerSession>;

const ALIAS_ROUTES = [
    'GET /api/finance/mail-aliases',
    'POST /api/finance/mail-aliases',
    'DELETE /api/finance/mail-aliases/[id]',
    'POST /api/finance/mail-aliases/[id]/approve',
];

function signIn(id: unknown, flags: Partial<Record<string, boolean>> = {}) {
    mockSession.mockResolvedValue({
        user: {
            id,
            isSysadmin: false,
            isBoardMember: false,
            isKeyholder: false,
            isBackgroundCheckReviewer: false,
            isOperations: false,
            isInventoryManager: false,
            isFinance: false,
            ...flags,
        },
        expires: '2099-01-01',
    });
}

async function status(endpoint: string) {
    const [method, path] = endpoint.split(' ');
    const request = new NextRequest(`http://localhost${path.replace('[id]', '1')}`, { method });
    return (await handler(endpoint, async () => ({}))(request, { params: Promise.resolve({ id: '1' }) })).status;
}

beforeEach(() => mockSession.mockReset());

describe('mail-alias routes', () => {
    it('registers exactly the four routes', () => {
        const registered = [...allRoutes()].map(([e]) => e).filter((e) => e.includes('/api/finance/mail-aliases'));
        expect(registered.sort()).toEqual([...ALIAS_ROUTES].sort());
    });

    it.each(ALIAS_ROUTES)('%s is finance-or-board with the same pii view for both', (endpoint) => {
        const spec = getRoute(endpoint)!;
        expect(spec.authorize).toBe('finance-or-board');
        expect(spec.returns).toEqual(['PersonMailAlias']);
        expect(spec.orderedView.map(([role]) => role)).toEqual(['isFinance', 'isBoardMember']);
        const views = new Map(spec.orderedView);
        expect(views.get('isFinance')).toContain('everyones:pii');
        expect(views.get('isBoardMember')).toEqual(views.get('isFinance'));
        expect(spec.orderedView.flatMap(([, tokens]) => tokens).some((t) => t.startsWith('their_own'))).toBe(false);
    });

    it.each(ALIAS_ROUTES)('%s admits FINANCE and the BOARD and refuses everyone else', async (endpoint) => {
        for (const flags of [{ isFinance: true }, { isBoardMember: true }]) {
            signIn(5, flags);
            expect(await status(endpoint)).toBe(200);
        }
        for (const flags of [{}, { isSysadmin: true }, { isOperations: true }, { isKeyholder: true }]) {
            signIn(5, flags);
            expect({ flags, status: await status(endpoint) }).toEqual({ flags, status: 403 });
        }
        signIn(undefined, { isFinance: true });
        expect(await status(endpoint)).toBe(401);
    });
});
