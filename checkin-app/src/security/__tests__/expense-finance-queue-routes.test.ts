/**
 * @jest-environment node
 */
/**
 * Admission and view for the finance queue's expense tabs (registry/expense.ts):
 * GET /api/expense/finance-queue and its counts admit FINANCE and BOARD only, the
 * expense detail carries the open queue reasons, and finance alone approves tax.
 * Auth runs through the real authenticateRequest; only next-auth's
 * getServerSession is stubbed (jest.setup.js mocks it).
 */
import type { NextRequest as NextRequestType } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { getRoute, type Token } from '@/security/core';
import type { CallerContext } from '@/security/access-resolvers';
import { handler } from '@/security/handler';
import { stripValue } from '@/security/stripper';

const { NextRequest } = jest.requireActual<{ NextRequest: typeof NextRequestType }>('next/server');
const mockSession = getServerSession as jest.MockedFunction<typeof getServerSession>;

const ROWS = 'GET /api/expense/finance-queue';
const COUNTS = 'GET /api/expense/finance-queue/counts';

type Flag = 'isFinance' | 'isBoardMember' | 'isInventoryManager' | 'isSysadmin' | 'isOperations' | 'isKeyholder';

function signIn(flags: Partial<Record<Flag, boolean>>) {
    mockSession.mockResolvedValue({
        user: {
            id: 5,
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

const ROW = {
    expenseId: 'e-1',
    vendorName: 'Acme',
    date: '2026-10-20',
    amountCents: 234000,
    currency: 'USD',
    reasons: ['board_approval_not_recorded'],
    waitingSince: '2026-10-21T09:00:00.000Z',
};
const tab = (actionable: number, total: number) => ({ actionable, total, byReason: { reimbursee_to_name: actionable } });
const TAB_COUNTS = { expenses: tab(1, 2), toSign: tab(0, 1), accountHolds: tab(0, 0), quickbooks: tab(1, 1), board: tab(0, 1) };

const BODIES: Record<string, Record<string, unknown>> = {
    [ROWS]: { FinanceQueueRow: [ROW] },
    [COUNTS]: { FinanceQueueCounts: TAB_COUNTS },
};
// A one-model response reaches the client unwrapped.
const WIRE: Record<string, unknown> = { [ROWS]: [ROW], [COUNTS]: TAB_COUNTS };
const URLS: Record<string, string> = {
    [ROWS]: 'http://localhost/api/expense/finance-queue?tab=board',
    [COUNTS]: 'http://localhost/api/expense/finance-queue/counts',
};

async function call(endpoint: string, flags: Partial<Record<Flag, boolean>>) {
    signIn(flags);
    const impl = jest.fn(async () => ({ ...BODIES[endpoint] }));
    const res = await handler(endpoint, impl)(new NextRequest(URLS[endpoint]), { params: Promise.resolve({}) });
    return { res, impl };
}

beforeEach(() => mockSession.mockReset());

describe('finance queue routes', () => {
    it.each([
        [ROWS, ['FinanceQueueRow']],
        [COUNTS, ['FinanceQueueCounts']],
    ])('registers %s for finance or the Board', (endpoint, returns) => {
        const route = getRoute(endpoint);
        expect(route?.authorize).toBe('finance-or-board');
        expect(route?.envelope).toBeNull();
        expect(route?.returns).toEqual(returns);
        expect(route?.orderedView.map(([role]) => role)).toEqual(['isFinance', 'isBoardMember']);
    });

    it.each([
        ['FINANCE', { isFinance: true }],
        ['BOARD', { isBoardMember: true }],
    ] as const)('gives %s every row and count field', async (_who, flags) => {
        for (const endpoint of [ROWS, COUNTS]) {
            const { res } = await call(endpoint, flags);
            expect(res.status).toBe(200);
            expect(await res.json()).toEqual(WIRE[endpoint]);
        }
    });

    it('drops a field the row does not declare', async () => {
        signIn({ isFinance: true });
        const impl = jest.fn(async () => ({ FinanceQueueRow: [{ ...ROW, reimbursementFor: 'Pat Doe', submitterId: 7 }] }));
        const res = await handler(ROWS, impl)(new NextRequest(URLS[ROWS]), { params: Promise.resolve({}) });
        expect(await res.json()).toEqual([ROW]);
    });

    it.each([
        ['a sysadmin', { isSysadmin: true }],
        ['an inventory manager', { isInventoryManager: true }],
        ['an operations volunteer', { isOperations: true }],
        ['a keyholder', { isKeyholder: true }],
        ['a person with no role', {}],
    ] as const)('403s %s without running the impl', async (_who, flags) => {
        for (const endpoint of [ROWS, COUNTS]) {
            const { res, impl } = await call(endpoint, flags);
            expect(res.status).toBe(403);
            expect(impl).not.toHaveBeenCalled();
        }
    });

    it('401s a signed-out caller', async () => {
        mockSession.mockResolvedValue(null);
        const impl = jest.fn(async () => ({}));
        const res = await handler(COUNTS, impl)(new NextRequest(URLS[COUNTS]), { params: Promise.resolve({}) });
        expect(res.status).toBe(401);
        expect(impl).not.toHaveBeenCalled();
    });
});

describe('expense detail reasons', () => {
    const ctx: CallerContext = {
        selfId: 1,
        householdId: undefined,
        isKeyholder: false,
        isKiosk: false,
        programsLed: new Set(),
        programsCoreVolIn: new Set(),
        participantIdsInScopePrograms: new Set(),
        householdIdsInScopePrograms: new Set(),
        eventIdsInScopePrograms: new Set(),
        activeVisitorIds: new Set(),
        ledHouseholdMemberIds: new Set(),
    };
    const reason = {
        code: 'qb_post_failed',
        tab: 'quickbooks',
        actionable: true,
        amountCents: null,
        count: 1,
        detail: 'Vendor Pat Doe is inactive',
    };
    const FULL: readonly Token[] = ['everyones:pii', 'everyones:personal', 'everyones:internal', 'public'];

    it('is part of the detail response', () => {
        expect(getRoute('GET /api/expense/expenses/[id]')?.returns).toContain('ExpenseQueueReason');
    });

    it('gives FINANCE and the Board the whole reason', () => {
        expect(stripValue('ExpenseQueueReason', [reason], FULL, ctx)).toEqual([reason]);
    });

    it("keeps an internal view's reason codes and strips the error text", () => {
        const { detail: _detail, ...codes } = reason;
        expect(stripValue('ExpenseQueueReason', reason, ['everyones:internal', 'public'], ctx)).toEqual(codes);
        expect(stripValue('ExpenseQueueReason', reason, ['public'], ctx)).toEqual({});
    });
});

describe('expense tax approval', () => {
    it('admits finance only, on the finance view', () => {
        const route = getRoute('POST /api/expense/expenses/[id]/tax-approval');
        expect(route?.authorize).toBe('finance');
        expect(route?.envelope).toBeNull();
        expect(route?.returns).toEqual(['Expense']);
        expect(route?.orderedView.map(([role]) => role)).toEqual(['isFinance']);
    });
});
