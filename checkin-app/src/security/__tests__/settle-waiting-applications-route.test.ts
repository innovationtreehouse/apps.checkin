/**
 * @jest-environment node
 */
/**
 * Admission and view for the Board's one-off run of the waiting-application settle
 * sweep (registry.ts): the Board reads the three counts and nothing else; a
 * signed-out caller and every other role, sysadmin included, are refused before
 * the sweep runs. Auth runs through the real authenticateRequest; only
 * next-auth's getServerSession is stubbed (jest.setup.js mocks it).
 */
import type { NextRequest as NextRequestType } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { classifications, getRoute, marks } from '@/security/core';
import { handler } from '@/security/handler';

const { NextRequest } = jest.requireActual<{ NextRequest: typeof NextRequestType }>('next/server');
const mockSession = getServerSession as jest.MockedFunction<typeof getServerSession>;

const ENDPOINT = 'POST /api/membership-ops/applications/settle-waiting';
const COUNTS = { households: 7, opened: 2, failed: 1 };

type Flag =
    | 'isFinance'
    | 'isBoardMember'
    | 'isInventoryManager'
    | 'isSysadmin'
    | 'isOperations'
    | 'isKeyholder'
    | 'isBackgroundCheckReviewer';
type Claims = Partial<Record<Flag, boolean>> & { isActiveOrgMember?: boolean; ageBand?: string };

function signIn(claims: Claims) {
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
            ...claims,
        },
        expires: '2099-01-01',
    });
}

async function call(claims: Claims | null, settled: object = COUNTS) {
    if (claims) signIn(claims);
    else mockSession.mockResolvedValue(null);
    const impl = jest.fn(async () => ({ ApplicationSettleCounts: settled }));
    const req = new NextRequest('http://localhost/api/membership-ops/applications/settle-waiting', { method: 'POST' });
    const res = await handler(ENDPOINT, impl)(req, { params: Promise.resolve({}) });
    return { res, impl };
}

beforeEach(() => mockSession.mockReset());

describe('Waiting-application settle route', () => {
    it('is registered for ApplicationSettleCounts alone, Board only', () => {
        const route = getRoute(ENDPOINT);
        expect(route?.returns).toEqual(['ApplicationSettleCounts']);
        expect(route?.authorize).toEqual({ anyRole: ['isBoardMember'] });
    });

    it('classifies the three counts as internal, with no finance mark', () => {
        expect(classifications.ApplicationSettleCounts).toEqual({
            households: 'internal',
            opened: 'internal',
            failed: 'internal',
        });
        expect(marks.ApplicationSettleCounts ?? []).toEqual([]);
    });

    it('lets the Board run the sweep and read the counts', async () => {
        const { res, impl } = await call({ isBoardMember: true });
        expect(res.status).toBe(200);
        expect(impl).toHaveBeenCalledTimes(1);
        expect(await res.json()).toEqual(COUNTS);
    });

    it('returns only the counts, whatever else the sweep hands back', async () => {
        const { res } = await call({ isBoardMember: true }, {
            ...COUNTS,
            householdIds: [11, 12],
            error: 'Household 12: lead jane@example.org has no consent',
        });
        expect(await res.json()).toEqual(COUNTS);
    });

    it.each([
        ['a sysadmin off the Board', { isSysadmin: true }],
        ['FINANCE', { isFinance: true }],
        ['a background-check reviewer', { isBackgroundCheckReviewer: true }],
        ['an inventory manager', { isInventoryManager: true }],
        ['an operations volunteer', { isOperations: true }],
        ['a keyholder', { isKeyholder: true }],
        ['an adult member', { isActiveOrgMember: true, ageBand: 'adult' }],
        ['a person with no role', {}],
    ] as const)('403s %s without running the sweep', async (_who, claims) => {
        const { res, impl } = await call(claims);
        expect(res.status).toBe(403);
        expect(impl).not.toHaveBeenCalled();
    });

    it('401s a signed-out caller without running the sweep', async () => {
        const { res, impl } = await call(null);
        expect(res.status).toBe(401);
        expect(impl).not.toHaveBeenCalled();
    });
});
