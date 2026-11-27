/**
 * @jest-environment node
 */
/**
 * Admission and view for the Board's current-members CSV export (registry.ts):
 * the Board reads the CSV text and its count and nothing else; a
 * signed-out caller and every other role, sysadmin included, are refused before
 * the export runs. Auth runs through the real authenticateRequest; only
 * next-auth's getServerSession is stubbed (jest.setup.js mocks it).
 */
import type { NextRequest as NextRequestType } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { classifications, getRoute, marks } from '@/security/core';
import { handler } from '@/security/handler';

const { NextRequest } = jest.requireActual<{ NextRequest: typeof NextRequestType }>('next/server');
const mockSession = getServerSession as jest.MockedFunction<typeof getServerSession>;

const ENDPOINT = 'GET /api/membership-ops/members/export';
const EXPORT = { csv: 'email,name,emailSuppressed,validThrough\r\n', count: 0 };

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

async function call(claims: Claims | null, body: object = EXPORT) {
    if (claims) signIn(claims);
    else mockSession.mockResolvedValue(null);
    const impl = jest.fn(async () => ({ MembersExport: body }));
    const req = new NextRequest('http://localhost/api/membership-ops/members/export', { method: 'GET' });
    const res = await handler(ENDPOINT, impl)(req, { params: Promise.resolve({}) });
    return { res, impl };
}

beforeEach(() => mockSession.mockReset());

describe('Members export route', () => {
    it('is registered for MembersExport alone, Board only', () => {
        const route = getRoute(ENDPOINT);
        expect(route?.returns).toEqual(['MembersExport']);
        expect(route?.authorize).toEqual({ anyRole: ['isBoardMember'] });
    });

    it('classifies the CSV as pii and the count as public, with no finance mark', () => {
        expect(classifications.MembersExport).toEqual({ csv: 'pii', count: 'public' });
        expect(marks.MembersExport ?? []).toEqual([]);
    });

    it('lets the Board run the export', async () => {
        const { res, impl } = await call({ isBoardMember: true });
        expect(res.status).toBe(200);
        expect(impl).toHaveBeenCalledTimes(1);
        expect(await res.json()).toEqual(EXPORT);
    });

    it('returns only csv and count, whatever else the route hands back', async () => {
        const { res } = await call({ isBoardMember: true }, {
            ...EXPORT,
            householdIds: [11, 12],
        });
        expect(await res.json()).toEqual(EXPORT);
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
    ] as const)('403s %s without running the export', async (_who, claims) => {
        const { res, impl } = await call(claims);
        expect(res.status).toBe(403);
        expect(impl).not.toHaveBeenCalled();
    });

    it('401s a signed-out caller without running the export', async () => {
        const { res, impl } = await call(null);
        expect(res.status).toBe(401);
        expect(impl).not.toHaveBeenCalled();
    });
});
