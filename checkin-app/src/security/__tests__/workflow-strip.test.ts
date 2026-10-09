/**
 * @jest-environment node
 */
/**
 * Boundary coverage for the workflow-mapping classifications (#1289 §5):
 *
 *   1. The stored receipt blob is `personal` and the schema carries no `pii`.
 *   2. No workflow model, generated or synthetic, names a submitter or
 *      reimbursement field — the parsed projections are the only receipt
 *      content a route can return.
 *   3. The stripper, under the read view's tokens (public + everyones:internal),
 *      drops the blob and any submitter/reimbursement key a projection grows,
 *      and keeps the nested line items.
 *   4. Admission (#1289 §6): INVENTORY_MANAGER, FINANCE and BOARD read; only
 *      INVENTORY_MANAGER writes; an id-less session is 401 on every route through
 *      the real authenticateRequest (only next-auth is mocked) and is denied the
 *      reads at the resolveAccess layer too; no route view-selects a sysadmin.
 */
import type { NextRequest as NextRequestType } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { stripValue } from '@/security/stripper';
import { resolveAccess, type CallerContext } from '@/security/access-resolvers';
import { allRoutes, getRoute, type Token } from '@/security/core';
import { handler } from '@/security/handler';
import type { AuthenticatedUser } from '@/types/auth';
import * as workflowGenerated from '@/security/generated/workflow-classifications';
import * as workflowSynthetic from '@/security/workflowSyntheticClassifications';
import '@/security/registry';

// jest.setup.js stubs next/server down to NextResponse.json; the request class is the real one.
const { NextRequest } = jest.requireActual<{ NextRequest: typeof NextRequestType }>('next/server');
const mockSession = getServerSession as jest.Mock;

const READ_TOKENS: readonly Token[] = ['everyones:internal', 'public'];

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

const FORBIDDEN_FIELDS = ['submitterId', 'needsReimbursement', 'reimbursementFor', 'reimburseePersonId', 'localUserId'];

const workflowMaps: Record<string, Record<string, string>> = {
    ...workflowGenerated.classifications,
    ...workflowSynthetic.classifications,
};

describe('workflow-mapping classifications', () => {
    it('tiers the stored receipt blob personal and nothing pii', () => {
        expect(workflowGenerated.classifications.ReceivedReceipt.receiptJson).toBe('personal');
        for (const [model, fields] of Object.entries(workflowMaps)) {
            for (const [field, tier] of Object.entries(fields)) {
                expect(`${model}.${field}:${tier}`).not.toMatch(/:(pii|secret)$/);
            }
        }
    });

    it('declares no submitter or reimbursement field on any workflow model', () => {
        const declared = Object.entries(workflowMaps).flatMap(([model, fields]) =>
            Object.keys(fields).map(f => `${model}.${f}`),
        );
        const leaked = declared.filter(mf => FORBIDDEN_FIELDS.includes(mf.split('.')[1]));
        expect(leaked).toEqual([]);
    });
});

describe('workflow-mapping stripper under the read view', () => {
    it('drops the receipt blob from a raw row', () => {
        const out = stripValue(
            'ReceivedReceipt',
            { id: 7, orgId: 'org-1', receiptId: 'r-1', state: 'pending_review', receiptJson: '{"submitterId":3}' },
            READ_TOKENS,
            ctx,
        ) as Record<string, unknown>;
        expect(out).toEqual({ id: 7, orgId: 'org-1', receiptId: 'r-1', state: 'pending_review' });
    });

    it('keeps line items and drops submitter/reimbursement keys on the detail view', () => {
        const out = stripValue(
            'WorkflowReceiptView',
            {
                receiptId: 'r-1',
                vendorName: 'Acme',
                receiptTotalCents: 1200,
                submitterId: 3,
                reimburseePersonId: 4,
                reimbursementFor: 'Pat',
                lineItems: [{ lineNumber: 1, description: 'M3 bolts', unitPriceCents: 600, submitterId: 3 }],
            },
            READ_TOKENS,
            ctx,
        ) as Record<string, unknown>;
        expect(out).toEqual({
            receiptId: 'r-1',
            vendorName: 'Acme',
            receiptTotalCents: 1200,
            lineItems: [{ lineNumber: 1, description: 'M3 bolts', unitPriceCents: 600 }],
        });
    });

    it('a public-only view sees no money or vendor', () => {
        const out = stripValue(
            'WorkflowReceiptSummary',
            { id: 7, state: 'apply_failed', vendorName: 'Acme', receiptTotalCents: 1200, lineItemCount: 2 },
            ['public'],
            ctx,
        );
        expect(out).toEqual({ id: 7, state: 'apply_failed', lineItemCount: 2 });
    });
});

describe('workflow-mapping admission', () => {
    const PREFIX = 'GET /api/workflow-mapping/';
    const routes = [...allRoutes()].filter(([e]) => e.includes(' /api/workflow-mapping/'));
    const reads = routes.filter(([e]) => e.startsWith(PREFIX)).map(([e]) => e);
    const writes = routes.filter(([e]) => !e.startsWith(PREFIX)).map(([e]) => e);

    const noFlags: AuthenticatedUser = {
        id: 1,
        email: 'wf@x.test',
        isSysadmin: false,
        isBoardMember: false,
        isKeyholder: false,
        isBackgroundCheckReviewer: false,
        isOperations: false,
        isInventoryManager: false,
        isFinance: false,
    };
    const as = (flags: Partial<AuthenticatedUser>): AuthenticatedUser => ({ ...noFlags, ...flags });
    const manager = as({ isInventoryManager: true });
    const finance = as({ isFinance: true });
    const board = as({ isBoardMember: true });
    const sysadmin = as({ isSysadmin: true });
    const idless = Object.assign(as({ isInventoryManager: true, isFinance: true, isBoardMember: true }), { id: undefined });

    async function call(endpoint: string, user: AuthenticatedUser | null) {
        mockSession.mockResolvedValue(user ? { user } : null);
        const body = jest.fn(async () => ({}));
        const res = await handler(endpoint, body)(new NextRequest('http://localhost/x'), {
            params: Promise.resolve({ id: '1', lineStatusId: '1' }),
        });
        return { status: res.status, ran: body.mock.calls.length > 0 };
    }

    beforeEach(() => mockSession.mockReset());

    it('registers the 4 reads and 6 writes', () => {
        expect(reads).toHaveLength(4);
        expect(writes).toHaveLength(6);
    });

    it.each(reads)('%s admits INVENTORY_MANAGER, FINANCE and BOARD', async (endpoint) => {
        for (const user of [manager, finance, board]) expect(await call(endpoint, user)).toEqual({ status: 200, ran: true });
    });

    it.each(reads)('%s 403s a sysadmin-only caller', async (endpoint) => {
        expect(await call(endpoint, sysadmin)).toEqual({ status: 403, ran: false });
    });

    it.each(writes)('%s admits INVENTORY_MANAGER only', async (endpoint) => {
        expect(await call(endpoint, manager)).toEqual({ status: 200, ran: true });
        for (const user of [finance, board, sysadmin]) expect(await call(endpoint, user)).toEqual({ status: 403, ran: false });
    });

    it.each([...reads, ...writes])('%s 401s anonymous and id-less sessions without running the body', async (endpoint) => {
        expect(await call(endpoint, null)).toEqual({ status: 401, ran: false });
        expect(await call(endpoint, idless)).toEqual({ status: 401, ran: false });
    });

    // Reads only: the writes' inventory-manager resolver checks the role flag, so
    // authenticateRequest's 401 above is what denies them an id-less session.
    it.each(reads)('%s denies an id-less session at the resolveAccess layer', async (endpoint) => {
        const { allowed } = await resolveAccess(getRoute(endpoint)!.authorize, {
            auth: { type: 'session', user: idless },
            params: {},
            callerContext: ctx,
        });
        expect(allowed).toBe(false);
    });

    it('no route view-selects isSysadmin', () => {
        const withSysadmin = routes.filter(([, r]) => r.orderedView.some(([role]) => role === 'isSysadmin'));
        expect(withSysadmin.map(([e]) => e)).toEqual([]);
    });
});
