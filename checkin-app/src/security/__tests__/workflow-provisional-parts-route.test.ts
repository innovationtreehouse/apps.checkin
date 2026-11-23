/**
 * @jest-environment node
 */
/**
 * Admission and view for the receipt picker's provisional parts
 * (registry/workflow.ts): an inventory manager reads each part's gtin13, name
 * and status and nothing else, so a rejection reason never leaves; every other
 * role is refused. Auth runs through the real authenticateRequest; only
 * next-auth's getServerSession is stubbed (jest.setup.js mocks it).
 */
import type { NextRequest as NextRequestType } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { getRoute } from '@/security/core';
import { handler } from '@/security/handler';
import '@/security/registry';

const { NextRequest } = jest.requireActual<{ NextRequest: typeof NextRequestType }>('next/server');
const mockSession = getServerSession as jest.MockedFunction<typeof getServerSession>;

const ENDPOINT = 'GET /api/workflow-mapping/provisional-parts';
const PART = { gtin13: '2000000000017', name: 'Birch plywood 3mm', status: 'pending' };

type Flag = 'isFinance' | 'isBoardMember' | 'isInventoryManager' | 'isSysadmin' | 'isOperations' | 'isKeyholder';
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

async function call(claims: Claims | null, rows: object[] = [PART]) {
    if (claims) signIn(claims);
    else mockSession.mockResolvedValue(null);
    const impl = jest.fn(async () => ({ WorkflowProvisionalPart: rows }));
    const req = new NextRequest('http://localhost/api/workflow-mapping/provisional-parts');
    const res = await handler(ENDPOINT, impl)(req, { params: Promise.resolve({}) });
    return { res, impl };
}

beforeEach(() => mockSession.mockReset());

describe('workflow provisional parts route', () => {
    it('is registered for WorkflowProvisionalPart alone', () => {
        expect(getRoute(ENDPOINT)?.returns).toEqual(['WorkflowProvisionalPart']);
    });

    it('lets an inventory manager read the three fields', async () => {
        const { res } = await call({ isInventoryManager: true });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual([PART]);
    });

    it('strips every other field, rejection reason included', async () => {
        const extra = {
            ...PART,
            status: 'rejected',
            rejectionReason: 'Duplicate of an existing catalog item',
            reviewedByUserId: 9,
            localUserId: 3,
            orgId: 'org-1',
        };
        const { res } = await call({ isInventoryManager: true }, [extra]);
        expect(await res.json()).toEqual([{ ...PART, status: 'rejected' }]);
    });

    it.each([
        ['FINANCE', { isFinance: true }],
        ['BOARD', { isBoardMember: true }],
        ['a sysadmin', { isSysadmin: true }],
        ['an operations volunteer', { isOperations: true }],
        ['a keyholder', { isKeyholder: true }],
        ['an adult member', { isActiveOrgMember: true, ageBand: 'adult' }],
        ['a person with no role', {}],
    ] as const)('403s %s without running the impl', async (_who, claims) => {
        const { res, impl } = await call(claims);
        expect(res.status).toBe(403);
        expect(impl).not.toHaveBeenCalled();
    });

    it('401s a signed-out caller', async () => {
        const { res, impl } = await call(null);
        expect(res.status).toBe(401);
        expect(impl).not.toHaveBeenCalled();
    });
});
