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
 *   4. The submitter view never returns donor or reimbursee names.
 *   5. The receipt file routes serve the uploader's own file and FINANCE's,
 *      and 404 anyone else's; both file columns are file-only.
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
const jsonRoutes = [...allRoutes()].map(([e]) => e).filter(e => RECEIPT.test(e));
const fileRoutes = [...allFileRoutes()].map(([e]) => e).filter(e => RECEIPT.test(e));

function request(endpoint: string) {
    const [method, path] = endpoint.split(' ');
    return new NextRequest(`http://localhost${path.replace(/\[[^\]]+\]/g, '1')}`, { method });
}
const params = { params: Promise.resolve({ id: '1', lineItemId: '1' }) };

beforeEach(() => mockSession.mockReset());

describe('receipt routes are registered', () => {
    it('registers the JSON routes and both file routes', () => {
        expect(jsonRoutes.length).toBeGreaterThan(20);
        expect(fileRoutes.sort()).toEqual(['GET /api/receipts/[id]/file', 'GET /api/receipts/mail-items/[id]/file']);
    });

    it('never admits public, kiosk or plain authenticated callers', () => {
        for (const e of [...jsonRoutes, ...fileRoutes]) {
            const spec = getRoute(e) ?? getFileRoute(e);
            expect(['catalog-viewer', 'finance', 'finance-or-board']).toContain(spec?.authorize);
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
        ]));
        expect(financeReads).toEqual(expect.arrayContaining(['GET /api/receipts', 'GET /api/receipts/[id]/audit-logs']));
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
        lineItems: [{ id: 1, receiptId: 'r-1', uploadedByUserId: 7, description: 'Arduino', totalPriceCents: 6989 }],
    };

    it('returns the uploader their own receipt, lines and paid status, without donor or reimbursee names', () => {
        const out = stripValue('ReceiptView', row, own, ctx) as Record<string, unknown>;
        expect(out).toMatchObject({ id: 'r-1', receiptTotalCents: 6989, validationNotes: 'rejected: wrong store', reimbursement: { paidOn: null } });
        expect(out.lineItems).toEqual(row.lineItems);
        for (const f of ['reimbursementFor', 'donorFirstName', 'donorLastName', 'donorCompanyName']) {
            expect(out).not.toHaveProperty(f);
        }
    });

    it("returns nothing of another person's receipt", () => {
        const out = stripValue('ReceiptView', row, own, { selfId: 8 } as CallerContext);
        expect(out).toEqual({ lineItems: [{}] });
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
