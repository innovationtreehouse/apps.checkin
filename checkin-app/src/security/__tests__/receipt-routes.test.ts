/**
 * @jest-environment node
 */
/**
 * Admission and per-row policy for the receipt routes (#1265 §6, plan rules 6
 * and 7), asserted on the registry entries in registry/receipt.ts:
 *
 *   1. An id-less session is denied on every receipt route: lib/auth resolves
 *      it as unauthenticated, so handler() and fileHandler() both 401 and the
 *      impl never runs; each route's admission gate refuses it too.
 *   2. `their_own` resolves on uploadedByUserId against the session id only;
 *      with no selfId it never holds.
 *
 * Auth runs through the real authenticateRequest; only next-auth's
 * getServerSession is stubbed (jest.setup.js mocks it).
 *   3. FINANCE-only routes refuse a non-finance session; BOARD reads with
 *      FINANCE's view on every finance-or-board route but does not act; a
 *      sysadmin gets nothing beyond the submitter view.
 *   4. The submitter view never returns donor or reimbursee names, or the id
 *      or rejection status of a suspected duplicate (another person's
 *      receipt); FINANCE sees both.
 *   5. The receipt file routes serve the uploader's own file and FINANCE's,
 *      and 404 anyone else's; both file columns are file-only.
 *   6. The submitter, shared and file routes admit an adult whose household
 *      membership is ACTIVE, and any role holder or staff account whatever
 *      their age or membership; they refuse an adult with no ACTIVE
 *      membership, and a youth or unknown age without a role.
 */
import type { NextRequest as NextRequestType } from 'next/server';
import { getServerSession } from 'next-auth/next';
import type { AuthResult } from '@/types/auth';
import { allFileRoutes, allRoutes, classifications, getFileRoute, getRoute, isFileOnlyField, type Token } from '@/security/core';
import { handler } from '@/security/handler';
import { fileHandler, type FileResult } from '@/security/fileHandler';
import { buildCallerContext, resolveAccess, scopesHeld, type CallerContext } from '@/security/access-resolvers';
import { stripValue } from '@/security/stripper';

const { NextRequest } = jest.requireActual<{ NextRequest: typeof NextRequestType }>('next/server');
const mockSession = getServerSession as jest.MockedFunction<typeof getServerSession>;

interface Flags {
    isFinance?: boolean;
    isBoardMember?: boolean;
    isSysadmin?: boolean;
    isOperations?: boolean;
    ageBand?: 'adult' | 'youth' | 'unknown';
    isActiveOrgMember?: boolean;
    isProgramVolunteer?: boolean;
    isKeyholder?: boolean;
    email?: string;
    hd?: string;
    emailVerified?: boolean;
}

function user(id: unknown, flags: Flags = {}) {
    return {
        id,
        isSysadmin: false,
        isBoardMember: false,
        isKeyholder: false,
        isBackgroundCheckReviewer: false,
        isOperations: false,
        isInventoryManager: false,
        isFinance: false,
        ...flags,
    };
}

/** What next-auth's getServerSession resolves for this caller. */
function signIn(id: unknown, flags: Flags = {}) {
    mockSession.mockResolvedValue({ user: user(id, flags), expires: '2099-01-01' });
}

const RECEIPT = /^[A-Z]+ \/api\/receipts(\/|$)/;
/** The reimbursee's confirmation: any signed-in person is admitted, and the library decides. */
const CONFIRMATION_ROUTES = ['GET /api/receipts/confirmations', 'POST /api/receipts/[id]/confirmation'];
/** What became of reimbursements someone else uploaded: any signed-in person is admitted, and sees their own. */
const REIMBURSED_ROUTE = 'GET /api/receipts/reimbursements';
const REIMBURSEE_ROUTES = [...CONFIRMATION_ROUTES, REIMBURSED_ROUTE];
const jsonRoutes = [...allRoutes()].map(([e]) => e).filter(e => RECEIPT.test(e));
const fileRoutes = [...allFileRoutes()].map(([e]) => e).filter(e => RECEIPT.test(e));

function request(endpoint: string) {
    const [method, path] = endpoint.split(' ');
    return new NextRequest(`http://localhost${path.replace(/\[[^\]]+\]/g, '1')}`, { method });
}
const params = { params: Promise.resolve({ id: '1', lineItemId: '1', otherId: '1' }) };

beforeEach(() => mockSession.mockReset());

describe('receipt routes are registered', () => {
    it('registers the JSON routes and both file routes', () => {
        expect(jsonRoutes.length).toBeGreaterThan(20);
        expect(fileRoutes.sort()).toEqual(['GET /api/receipts/[id]/file', 'GET /api/receipts/mail-items/[id]/file']);
    });

    it('never admits public, kiosk or plain authenticated callers, except to the reimbursee\'s own routes', () => {
        for (const e of [...jsonRoutes, ...fileRoutes].filter((e) => !REIMBURSEE_ROUTES.includes(e))) {
            const spec = getRoute(e) ?? getFileRoute(e);
            expect(['receipt-submitter', 'finance', 'finance-or-board']).toContain(spec?.authorize);
        }
    });
});

describe('an id-less session is denied', () => {
    it.each([{}, { isFinance: true }, { isBoardMember: true }] as Flags[])(
        'every JSON receipt route 401s an id-less session (flags %j) without running the impl',
        async (flags) => {
            for (const endpoint of jsonRoutes) {
                signIn(undefined, flags);
                const impl = jest.fn(async () => ({}));
                const res = await handler(endpoint, impl)(request(endpoint), params);
                expect({ endpoint, status: res.status }).toEqual({ endpoint, status: 401 });
                expect(impl).not.toHaveBeenCalled();
            }
        },
    );

    it.each(fileRoutes)('%s 401s an id-less session', async (endpoint) => {
        signIn(undefined, { isFinance: true });
        const impl = jest.fn();
        const res = await fileHandler(endpoint, impl)(request(endpoint), params);
        expect(res.status).toBe(401);
        expect(impl).not.toHaveBeenCalled();
    });

    it('every receipt admission gate refuses an id-less session that reaches it', async () => {
        for (const e of [...jsonRoutes, ...fileRoutes]) {
            const spec = getRoute(e) ?? getFileRoute(e);
            for (const flags of [{ isFinance: true }, { isBoardMember: true }, { isSysadmin: true }] as Flags[]) {
                const auth = { type: 'session', user: user(undefined, flags) } as AuthResult;
                const callerContext = await buildCallerContext(auth, spec!.ctxNeeds);
                const { allowed } = await resolveAccess(spec!.authorize, { auth, params: {}, callerContext });
                expect({ e, flags, allowed }).toEqual({ e, flags, allowed: false });
            }
        }
    });

    it('their_own never holds without a session id, even on a row with no uploader', () => {
        const noId = { selfId: undefined } as CallerContext;
        for (const model of ['Receipt', 'ReceiptView', 'ReceiptLineView']) {
            expect(scopesHeld(model, { uploadedByUserId: 7 }, noId).has('their_own')).toBe(false);
            expect(scopesHeld(model, { uploadedByUserId: undefined }, noId).has('their_own')).toBe(false);
            expect(scopesHeld(model, {}, noId).has('their_own')).toBe(false);
        }
        expect(scopesHeld('ReceiptView', { uploadedByUserId: 7 }, { selfId: 7 } as CallerContext).has('their_own')).toBe(true);
    });
});

describe('role admission', () => {
    const financeOnly = jsonRoutes.filter(e => getRoute(e)?.authorize === 'finance');
    const financeReads = jsonRoutes.filter(e => getRoute(e)?.authorize === 'finance-or-board');

    it('has finance-only actions and finance-or-board reads', () => {
        expect(financeOnly).toEqual(expect.arrayContaining([
            'POST /api/receipts/[id]/approve',
            'POST /api/receipts/import',
            'GET /api/receipts/mail-items',
            'POST /api/receipts/[id]/ignore-file',
            'GET /api/receipts/ignored-files',
            'DELETE /api/receipts/ignored-files/[id]',
            'POST /api/receipts/[id]/not-this-one',
            'DELETE /api/receipts/[id]/not-this-one/[otherId]',
            'POST /api/receipts/[id]/different-purchases',
            'POST /api/receipts/[id]/keep-this-one',
        ]));
        expect(financeReads).toEqual(expect.arrayContaining(['GET /api/receipts', 'GET /api/receipts/[id]/audit-logs', 'GET /api/receipts/[id]/duplicate-group']));
    });

    it.each([
        ['an operations volunteer', { isOperations: true }],
        ['a sysadmin', { isSysadmin: true }],
        ['a board member', { isBoardMember: true }],
    ] as const)('finance-only routes 403 %s', async (_who, flags) => {
        for (const endpoint of financeOnly) {
            signIn(5, flags);
            const impl = jest.fn(async () => ({}));
            const res = await handler(endpoint, impl)(request(endpoint), params);
            expect({ endpoint, status: res.status }).toEqual({ endpoint, status: 403 });
        }
    });

    it('finance-or-board reads 403 a sysadmin and admit a board member', async () => {
        for (const endpoint of financeReads) {
            signIn(5, { isSysadmin: true });
            expect((await handler(endpoint, async () => ({}))(request(endpoint), params)).status).toBe(403);
            signIn(5, { isBoardMember: true });
            expect((await handler(endpoint, async () => ({}))(request(endpoint), params)).status).toBe(200);
        }
    });

    it.each(financeReads)('%s gives BOARD the same view as FINANCE, names included', async (endpoint) => {
        const spec = getRoute(endpoint)!;
        const views = new Map(spec.orderedView);
        expect(views.get('isBoardMember')).toEqual(views.get('isFinance'));

        const model = spec.returns![0];
        const tiers = classifications[model as keyof typeof classifications] as Record<string, string>;
        const row = Object.fromEntries(Object.keys(tiers).map(f => [f, 1]));
        const sensitive = Object.keys(tiers).filter(f => tiers[f] === 'pii' || tiers[f] === 'personal');
        const bodies: unknown[] = [];
        for (const flags of [{ isFinance: true }, { isBoardMember: true }] as Flags[]) {
            signIn(5, flags);
            const res = await handler(endpoint, async () => ({ [model]: [row] }))(request(endpoint), params);
            expect(res.status).toBe(200);
            bodies.push(await res.json());
        }
        expect(bodies[1]).toEqual(bodies[0]);
        const [first] = bodies[1] as Record<string, unknown>[];
        for (const f of sensitive.filter(f => !isFileOnlyField(model, f))) expect(first).toHaveProperty(f, 1);
        if (model === 'ReceiptView') {
            for (const f of ['reimbursementFor', 'donorFirstName', 'donorLastName', 'donorCompanyName']) {
                expect(first).toHaveProperty(f, 1);
            }
        }
    });

    it('no receipt view grants a sysadmin anything', () => {
        for (const e of [...jsonRoutes, ...fileRoutes]) {
            const spec = getRoute(e) ?? getFileRoute(e);
            expect(spec?.orderedView.map(([role]) => role)).not.toContain('isSysadmin');
        }
    });
});

describe('receipt submitter admission', () => {
    const SUBMITTER_ROUTES = [
        'POST /api/receipts/upload',
        'GET /api/receipts/mine',
        'POST /api/receipts/[id]/submitter-confirm',
        'POST /api/receipts/[id]/submitter-discard',
        'PUT /api/receipts/[id]/reimbursement',
        'PUT /api/receipts/[id]/in-kind',
        'GET /api/receipts/reimbursee-options',
        'GET /api/receipts/needs-attention',
        'GET /api/receipts/[id]',
        'PATCH /api/receipts/[id]',
        'POST /api/receipts/[id]/line-items',
        'PATCH /api/receipts/[id]/line-items/[lineItemId]',
        'DELETE /api/receipts/[id]/line-items/[lineItemId]',
        'POST /api/receipts/[id]/retry-ocr',
        'POST /api/receipts/[id]/acknowledge-rejection',
        'POST /api/receipts/[id]/discard',
        'POST /api/receipts/[id]/resubmit',
    ];
    const RECEIPT_FILE = 'GET /api/receipts/[id]/file';
    const status = async (endpoint: string, flags: Flags) => {
        signIn(9, flags);
        return (await handler(endpoint, async () => ({}))(request(endpoint), params)).status;
    };
    const fileStatus = async (flags: Flags, uploadedByUserId: number) => {
        signIn(9, flags);
        const result: FileResult = { row: { id: 'r-1', uploadedByUserId, fileBlob: new Uint8Array([1]) }, contentType: 'application/pdf' };
        return (await fileHandler(RECEIPT_FILE, async () => result)(request(RECEIPT_FILE), params)).status;
    };

    it('gates the submitter, shared and file routes on receipt-submitter', () => {
        expect(jsonRoutes.filter(e => getRoute(e)?.authorize === 'receipt-submitter').sort()).toEqual([...SUBMITTER_ROUTES].sort());
        expect(getFileRoute(RECEIPT_FILE)?.authorize).toBe('receipt-submitter');
    });

    it("serves an adult member their own receipt file and 404s someone else's", async () => {
        expect(await fileStatus({ ageBand: 'adult', isActiveOrgMember: true }, 9)).toBe(200);
        expect(await fileStatus({ ageBand: 'adult', isActiveOrgMember: true }, 8)).toBe(404);
    });

    it('refuses a youth with no role on the receipt file route', async () => {
        expect(await fileStatus({ ageBand: 'youth' }, 9)).toBe(403);
        expect(await fileStatus({ ageBand: 'youth', isActiveOrgMember: true }, 9)).toBe(403);
    });

    it('refuses an adult with no ACTIVE membership their own receipt file', async () => {
        expect(await fileStatus({ ageBand: 'adult' }, 9)).toBe(403);
        expect(await fileStatus({ ageBand: 'adult', isActiveOrgMember: false }, 9)).toBe(403);
    });

    it('admits a FINANCE holder of unknown age to the shared routes', async () => {
        for (const endpoint of ['PATCH /api/receipts/[id]', 'GET /api/receipts/[id]', 'GET /api/receipts/needs-attention']) {
            expect({ endpoint, status: await status(endpoint, { isFinance: true }) }).toEqual({ endpoint, status: 200 });
        }
    });

    it.each([
        ['an adult with an ACTIVE membership and no role', { ageBand: 'adult', isActiveOrgMember: true }],
        ['a role holder of unknown age with no membership', { isKeyholder: true }],
        ['a staff account with no membership', { email: 'staff@innovationtreehouse.org', hd: 'innovationtreehouse.org', emailVerified: true }],
    ] as [string, Flags][])('admits %s', async (_who, flags) => {
        for (const endpoint of SUBMITTER_ROUTES) {
            expect({ endpoint, status: await status(endpoint, flags) }).toEqual({ endpoint, status: 200 });
        }
    });

    it.each([
        ['an adult with no role and no membership', { ageBand: 'adult' }],
        ['an adult whose background check is pending (membership not ACTIVE)', { ageBand: 'adult', isProgramVolunteer: true, isActiveOrgMember: false }],
        ['a youth', { ageBand: 'youth' }],
        ['a youth with an ACTIVE membership', { ageBand: 'youth', isActiveOrgMember: true }],
        ['a program-volunteer youth with an ACTIVE membership', { ageBand: 'youth', isProgramVolunteer: true, isActiveOrgMember: true }],
        ['a caller of unknown age', { ageBand: 'unknown' }],
        ['a caller with no age band', {}],
    ] as [string, Flags][])('refuses %s', async (_who, flags) => {
        for (const endpoint of SUBMITTER_ROUTES) {
            expect({ endpoint, status: await status(endpoint, flags) }).toEqual({ endpoint, status: 403 });
        }
    });
});

describe('the reimbursee options', () => {
    const view = getRoute('GET /api/receipts/reimbursee-options')!;

    it('returns a submitter each option\'s id and name, and nothing else', async () => {
        expect(view.orderedView).toEqual([['authenticated', ['public']]]);
        signIn(9, { ageBand: 'adult', isActiveOrgMember: true });
        const option = { id: 42, name: 'Sam Lee', email: 'sam@example.com', householdId: 3 };
        const res = await handler('GET /api/receipts/reimbursee-options', async () => ({ ReceiptReimburseeOption: [option] }))(
            request('GET /api/receipts/reimbursee-options'),
            params,
        );
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual([{ id: 42, name: 'Sam Lee' }]);
    });
});

describe('the confirmation that signs a reimbursement', () => {
    const views = (e: string) => new Map(getRoute(e)!.orderedView);
    const line = { id: 1, reimburseePersonId: 9, lineNumber: 1, description: 'Arduino', quantity: 1, unitPriceCents: 6989, totalPriceCents: 6989, isDelayed: false };
    const row = {
        id: 'r-1', reimburseePersonId: 9, state: 'submitter_review', retailer: 'Acme', receiptDate: '2026-10-01', currency: 'USD',
        shippingCents: 0, taxCents: 0, discountCents: 0, receiptTotalCents: 6989, onBehalf: false, changedFields: [],
        uploadedByUserId: 7, reimbursementFor: 'Sam Lee', validationNotes: 'note', lineItems: [line],
    };

    it('admits any signed-in person, and shows the Board everyone\'s and anyone else their own', () => {
        for (const e of CONFIRMATION_ROUTES) {
            expect(getRoute(e)?.authorize).toBe('authenticated');
            expect(getRoute(e)?.orderedView).toEqual([['isBoardMember', ['everyones:internal']], ['authenticated', ['their_own:internal']]]);
        }
    });

    it('returns the person reimbursed the receipt and lines, and no uploader, name or note', () => {
        const own = views(CONFIRMATION_ROUTES[0]).get('authenticated')!;
        const out = stripValue('ReceiptConfirmationView', row, own, { selfId: 9 } as CallerContext) as Record<string, unknown>;
        const { uploadedByUserId: _u, reimbursementFor: _r, validationNotes: _v, ...expected } = row;
        expect(out).toEqual(expected);
    });

    it('returns nothing to anyone else, the uploader included', () => {
        const own = views(CONFIRMATION_ROUTES[0]).get('authenticated')!;
        expect(stripValue('ReceiptConfirmationView', row, own, { selfId: 7 } as CallerContext)).toEqual({ lineItems: [{}] });
    });

    it('returns a Board member the receipt they confirm on the reimbursee\'s behalf', () => {
        const board = views(CONFIRMATION_ROUTES[1]).get('isBoardMember')!;
        const out = stripValue('ReceiptConfirmationView', { ...row, onBehalf: true }, board, { selfId: 5 } as CallerContext) as Record<string, unknown>;
        expect(out.onBehalf).toBe(true);
        expect(out.lineItems).toEqual([line]);
        expect(out).not.toHaveProperty('reimbursementFor');
    });

    it('admits a reimbursee whose membership lapsed, who is no receipt submitter', async () => {
        const lapsed = { type: 'session', user: user(9, { ageBand: 'adult', isActiveOrgMember: false }) } as AuthResult;
        for (const e of CONFIRMATION_ROUTES) {
            const spec = getRoute(e)!;
            expect((await resolveAccess('receipt-submitter', { auth: lapsed, params: {}, callerContext: await buildCallerContext(lapsed, spec.ctxNeeds) })).allowed).toBe(false);
            expect((await resolveAccess(spec.authorize, { auth: lapsed, params: {}, callerContext: await buildCallerContext(lapsed, spec.ctxNeeds) })).allowed).toBe(true);
        }
    });

    it('drops a line missing its reimbursee stamp (fails closed)', () => {
        const own = views(CONFIRMATION_ROUTES[0]).get('authenticated')!;
        expect(stripValue('ReceiptConfirmationLineView', { id: 1, description: 'Arduino' }, own, { selfId: 9 } as CallerContext)).toEqual({});
    });
});

describe('what became of a reimbursement someone else uploaded', () => {
    const view = () => new Map(getRoute(REIMBURSED_ROUTE)!.orderedView);
    const row = {
        id: 'r-1', reimburseePersonId: 9, state: 'receipt_finalized', retailer: 'Acme', receiptDate: '2026-10-01', currency: 'USD',
        receiptTotalCents: 6989, rejectionReason: null, reimbursement: { paidOn: null },
        purchaseOutcome: { receiving: 'received', money: { status: 'line_rejected', notes: ['Not a program cost'] }, gift: null },
    };

    it('admits any signed-in person and shows each their own, notes included', () => {
        expect(getRoute(REIMBURSED_ROUTE)?.authorize).toBe('authenticated');
        expect(getRoute(REIMBURSED_ROUTE)?.orderedView).toEqual([['authenticated', ['their_own:personal', 'their_own:internal']]]);
        const own = view().get('authenticated')!;
        expect(stripValue('ReceiptReimbursedView', row, own, { selfId: 9 } as CallerContext)).toEqual(row);
    });

    it('returns nothing to anyone else, the uploader included', () => {
        const own = view().get('authenticated')!;
        expect(stripValue('ReceiptReimbursedView', row, own, { selfId: 7 } as CallerContext)).toEqual({});
    });

    it('drops an uploader, donor or name field the library might pass through', () => {
        const own = view().get('authenticated')!;
        const leaky = { ...row, uploadedByUserId: 7, reimbursementFor: 'Sam Lee', donorFirstName: 'Pat', validationNotes: 'x' };
        expect(stripValue('ReceiptReimbursedView', leaky, own, { selfId: 9 } as CallerContext)).toEqual(row);
    });
});

describe('the discard route', () => {
    const DISCARD = 'POST /api/receipts/[id]/discard';

    it('holds the submitter view alone, so no role acts on it org-wide', () => {
        expect(getRoute(DISCARD)?.orderedView).toEqual(getRoute('POST /api/receipts/[id]/submitter-discard')?.orderedView);
        expect(getRoute(DISCARD)?.orderedView.map(([role]) => role)).toEqual(['authenticated']);
    });

    it.each([
        ['FINANCE', { isFinance: true }],
        ['the Board', { isBoardMember: true }],
    ] as [string, Flags][])("returns %s nothing of another person's receipt", async (_who, flags) => {
        signIn(5, { ...flags, ageBand: 'adult', isActiveOrgMember: true });
        const other = { id: 'r-1', uploadedByUserId: 8, receiptTotalCents: 6989, donorFirstName: 'Pat' };
        const res = await handler(DISCARD, async () => ({ ReceiptView: other }))(request(DISCARD), params);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({});
    });
});

describe('the submitter view', () => {
    const own = getRoute('GET /api/receipts/mine')?.orderedView[0][1] as readonly Token[];
    const ctx = { selfId: 7 } as CallerContext;
    const row = {
        id: 'r-1',
        uploadedByUserId: 7,
        receiptTotalCents: 6989,
        validationNotes: 'rejected: wrong store',
        reimbursementFor: 'Sam Lee',
        donorFirstName: 'Pat',
        donorLastName: 'Doe',
        donorCompanyName: 'Doe Hardware',
        reimbursement: { paidOn: null },
        purchaseOutcome: { receiving: 'received', money: { status: 'line_rejected', notes: ['Not a program cost'] }, gift: null },
        lineItems: [{ id: 1, receiptId: 'r-1', uploadedByUserId: 7, description: 'Arduino', totalPriceCents: 6989 }],
    };

    it('returns the uploader their own receipt, lines, paid status and purchase outcome, without donor or reimbursee names', () => {
        const out = stripValue('ReceiptView', row, own, ctx) as Record<string, unknown>;
        expect(out).toMatchObject({ id: 'r-1', receiptTotalCents: 6989, validationNotes: 'rejected: wrong store', reimbursement: { paidOn: null }, purchaseOutcome: row.purchaseOutcome });
        expect(out.lineItems).toEqual(row.lineItems);
        for (const f of ['reimbursementFor', 'donorFirstName', 'donorLastName', 'donorCompanyName']) {
            expect(out).not.toHaveProperty(f);
        }
    });

    it("returns nothing of another person's receipt", () => {
        const out = stripValue('ReceiptView', row, own, { selfId: 8 } as CallerContext);
        expect(out).toEqual({ lineItems: [{}] });
    });

    it('strips the suspected-duplicate receipt id and rejection status from the uploader on every receipt route', () => {
        const flagged = { ...row, duplicateSuspectReceiptId: 'r-other', duplicateSuspectIsRejected: true, duplicateFlaggedAt: '2026-10-01T00:00:00.000Z' };
        for (const endpoint of jsonRoutes) {
            const views = new Map(getRoute(endpoint)!.orderedView);
            const submitter = views.get('authenticated');
            if (!submitter || !getRoute(endpoint)!.returns?.includes('ReceiptView')) continue;
            const out = stripValue('ReceiptView', flagged, submitter, ctx) as Record<string, unknown>;
            expect({ endpoint, leaked: 'duplicateSuspectReceiptId' in out }).toEqual({ endpoint, leaked: false });
            expect({ endpoint, leaked: 'duplicateSuspectIsRejected' in out }).toEqual({ endpoint, leaked: false });
            expect(out.duplicateFlaggedAt).toBe(flagged.duplicateFlaggedAt);
        }
    });

    it('returns the suspected-duplicate receipt id and rejection status to FINANCE', () => {
        const finance = new Map(getRoute('GET /api/receipts/[id]')!.orderedView).get('isFinance')!;
        const out = stripValue('ReceiptView', { ...row, duplicateSuspectReceiptId: 'r-other', duplicateSuspectIsRejected: true }, finance, { selfId: 5 } as CallerContext) as Record<string, unknown>;
        expect(out.duplicateSuspectReceiptId).toBe('r-other');
        expect(out.duplicateSuspectIsRejected).toBe(true);
    });

    it('drops a line item missing its owner stamp (fails closed)', () => {
        const out = stripValue('ReceiptLineView', { id: 1, description: 'Arduino' }, own, ctx);
        expect(out).toEqual({});
    });
});

describe('receipt file routes', () => {
    const BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    const RECEIPT_FILE = 'GET /api/receipts/[id]/file';
    const MAIL_FILE = 'GET /api/receipts/mail-items/[id]/file';
    const file = (uploadedByUserId: number): FileResult => ({
        row: { id: 'r-1', uploadedByUserId, fileBlob: BYTES },
        contentType: 'application/pdf',
    });
    const call = (endpoint: string, result: FileResult) =>
        fileHandler(endpoint, async () => result)(request(endpoint), params);

    it('names both file columns, making them file-only', () => {
        expect(isFileOnlyField('Receipt', 'fileBlob')).toBe(true);
        expect(isFileOnlyField('ReceiptMailItem', 'fileBlob')).toBe(true);
    });

    it("serves the uploader their own file and 404s someone else's", async () => {
        signIn(7, { isOperations: true });
        expect((await call(RECEIPT_FILE, file(7))).status).toBe(200);
        expect((await call(RECEIPT_FILE, file(8))).status).toBe(404);
    });

    it("serves FINANCE and BOARD any receipt's file; a sysadmin only their own", async () => {
        signIn(5, { isFinance: true });
        expect((await call(RECEIPT_FILE, file(8))).status).toBe(200);
        signIn(5, { isBoardMember: true });
        expect((await call(RECEIPT_FILE, file(8))).status).toBe(200);
        signIn(5, { isSysadmin: true });
        expect((await call(RECEIPT_FILE, file(8))).status).toBe(404);
    });

    it('serves a held mail file to FINANCE only', async () => {
        const held: FileResult = { row: { id: 1, fileBlob: BYTES }, contentType: 'image/png' };
        signIn(5, { isFinance: true });
        const res = await call(MAIL_FILE, held);
        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Security-Policy')).toBe('sandbox');
        expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
        signIn(5, { isBoardMember: true });
        expect((await call(MAIL_FILE, held)).status).toBe(403);
    });

    it('serves a receipt image inline under a sandbox and a PDF inline without one', async () => {
        signIn(7, { isOperations: true });
        const img = await call(RECEIPT_FILE, { ...file(7), contentType: 'image/jpeg' });
        expect(img.headers.get('Content-Disposition')).toBe('inline');
        expect(img.headers.get('Content-Security-Policy')).toBe('sandbox');
        const pdf = await call(RECEIPT_FILE, file(7));
        expect(pdf.headers.get('Content-Disposition')).toBe('inline');
        expect(pdf.headers.get('Content-Security-Policy')).toBeNull();
        expect(pdf.headers.get('X-Content-Type-Options')).toBe('nosniff');
    });
});
