/**
 * @jest-environment node
 *
 * Finance view log contract (docs/in-design/FINANCE_VIEW_RECORD_IDS.md): a GET response
 * is logged when the stripped bag carries a marked field on a row that is not the
 * viewer's own. The log names each record as `Model:id` with the marked field names it
 * was sent. The writer (merging, windows, repeats) is covered by its own tests.
 */
import type { NextRequest as NextRequestType } from 'next/server';
import type { AuthResult } from '@/types/auth';
import {
    defineFileRoute,
    defineRoute,
    financeViewErrors,
    getFileRoute,
    getRoute,
    markErrors,
    marks,
    marksVisible,
    type OrderedViewEntry,
    type RouteSpec,
} from '@/security/core';
import '@/security/registry';
import { handler, type ModelBag } from '@/security/handler';
import { fileHandler } from '@/security/fileHandler';
import {
    isOwnRow,
    pageViewFoldErrors,
    pageViewTag,
    rowRecords,
    PAGE_VIEW_ID_HEADER,
    PAGE_VIEW_PATH_HEADER,
} from '@/security/financeView';
import type { CallerContext } from '@/security/access-resolvers';
import { authenticateRequest } from '@/lib/auth';
import { pageViewDisposition, recordFinanceViewCall, type FinanceViewCall } from '@/lib/finance/financeViewLog';

jest.mock('@/lib/auth', () => ({ authenticateRequest: jest.fn() }));
jest.mock('@/lib/finance/financeViewLog', () => ({
    ...jest.requireActual('@/lib/finance/financeViewLog'),
    recordFinanceViewCall: jest.fn(),
}));
// jest.setup.js stubs next/server down to NextResponse.json; the request class is the real one.
const { NextRequest } = jest.requireActual<{ NextRequest: typeof NextRequestType }>('next/server');
const mockAuth = authenticateRequest as jest.MockedFunction<typeof authenticateRequest>;
const mockRecord = recordFinanceViewCall as jest.MockedFunction<typeof recordFinanceViewCall>;

const FULL = ['everyones:pii', 'everyones:personal', 'everyones:internal', 'public'] as const;
// ReceiptView binds `their_own` on uploadedByUserId: the submitter's own receipt.
const VIEW: readonly OrderedViewEntry[] = [
    ['isBoardMember', FULL],
    ['authenticated', ['everyones:internal']],
];
const RECEIPTS = 'GET /api/__test__/fv/receipts/[id]';
const UNMARKED = 'GET /api/__test__/fv/ignored-files';
const WRITE = 'POST /api/__test__/fv/receipts';
const FILE = 'GET /api/__test__/fv/receipt-file/[id]';
const UNMARKED_FILE = 'GET /api/__test__/fv/person-file/[id]';

defineRoute({
    endpoint: RECEIPTS,
    authorize: 'authenticated',
    envelope: null,
    returns: ['ReceiptView', 'ReceiptLineView'],
    orderedView: VIEW,
    financeView: { records: [{ key: 'ReceiptView', id: 'id', model: 'Receipt' }], query: ['tab'] },
});
defineRoute({ endpoint: UNMARKED, authorize: 'authenticated', envelope: null, returns: ['ReceiptIgnoredFileView'], orderedView: VIEW });
defineRoute({ endpoint: WRITE, authorize: 'authenticated', envelope: null, returns: ['ReceiptView'], orderedView: VIEW });
defineFileRoute({ endpoint: FILE, authorize: 'authenticated', orderedView: [['isBoardMember', FULL], ['authenticated', ['their_own:pii']]], file: { model: 'Receipt', field: 'fileBlob' } });
defineFileRoute({ endpoint: UNMARKED_FILE, authorize: 'authenticated', orderedView: [['isBoardMember', FULL]], file: { model: 'Person', field: 'email' } });

function session(id: number, isBoardMember = false, householdId = 50): AuthResult {
    return {
        type: 'session',
        user: { id, householdId, isSysadmin: false, isBoardMember, isKeyholder: false, isBackgroundCheckReviewer: false, isOperations: false },
    } as AuthResult;
}

function request(url: string, headers: Record<string, string> = {}) {
    return new NextRequest(url, { headers });
}

function get(endpoint: string, bag: ModelBag, opts: { params?: Record<string, string>; url?: string; headers?: Record<string, string> } = {}) {
    const route = handler(endpoint, async () => bag);
    return route(request(opts.url ?? 'http://localhost/api/__test__/fv/receipts/r1?q=Jane%20Donor&tab=held', opts.headers), {
        params: Promise.resolve(opts.params ?? { id: 'r1' }),
    });
}

function written(): FinanceViewCall {
    expect(mockRecord).toHaveBeenCalledTimes(1);
    return mockRecord.mock.calls[0][0];
}

beforeEach(() => {
    mockAuth.mockReset();
    mockRecord.mockReset();
    mockRecord.mockResolvedValue(undefined);
});

describe('handler — logging from marks', () => {
    it('logs a marked view: the record, its marked field names, the call', async () => {
        mockAuth.mockResolvedValue(session(1, true));
        const res = await get(RECEIPTS, {
            ReceiptView: [{ id: 'r1', uploadedByUserId: 9, retailer: 'Hardware', receiptTotalCents: 1200 }],
        });
        expect(res.status).toBe(200);
        expect(written()).toEqual({
            actorId: 1,
            role: 'isBoardMember',
            endpoint: RECEIPTS,
            path: '/api/__test__/fv/receipts/r1',
            query: { tab: 'held' },
            records: [{ ref: 'Receipt:r1', fields: ['receiptTotalCents', 'retailer', 'uploadedByUserId'] }],
            pageView: null,
        });
    });

    it('records neither an undeclared query parameter nor any field value', async () => {
        mockAuth.mockResolvedValue(session(1, true));
        await get(RECEIPTS, { ReceiptView: { id: 'r1', donorFirstName: 'Jane', receiptTotalCents: 1200 } });
        const text = JSON.stringify(written());
        expect(text).not.toContain('Jane');
        expect(text).not.toContain('1200');
    });

    it('does not log a view with no marked field', async () => {
        mockAuth.mockResolvedValue(session(1, true));
        const res = await get(UNMARKED, { ReceiptIgnoredFileView: [{ id: 'f1', fileHash: 'abc', reason: 'spam' }] });
        expect(res.status).toBe(200);
        expect(mockRecord).not.toHaveBeenCalled();
    });

    it('does not log a write that echoes a marked field', async () => {
        mockAuth.mockResolvedValue(session(1, true));
        const route = handler(WRITE, async () => ({ ReceiptView: { id: 'r1', receiptTotalCents: 1200 } }));
        const res = await route(new NextRequest('http://localhost/api/__test__/fv/receipts', { method: 'POST' }), {});
        expect(res.status).toBe(200);
        expect(mockRecord).not.toHaveBeenCalled();
    });

    it('names a nested row\'s marked fields under the row that holds it', async () => {
        mockAuth.mockResolvedValue(session(1, true));
        await get(RECEIPTS, { ReceiptView: { id: 'r1', lineItems: [{ id: 'l1', unitPriceCents: 300, totalPriceCents: 600 }] } });
        expect(written().records).toEqual([
            { ref: 'Receipt:r1', fields: ['lineItems.totalPriceCents', 'lineItems.unitPriceCents'] },
        ]);
    });

    it('reads the stripped bag: a field or key the viewer is not sent is never named', async () => {
        // The plain member holds everyones:internal: amounts, but no donor name (pii).
        mockAuth.mockResolvedValue(session(1));
        await get(RECEIPTS, {
            ReceiptView: [
                { id: 'r1', receiptTotalCents: 1200, donorFirstName: 'Jane' },
                { id: 'r2', donorLastName: 'Doe' },
            ],
            NotAModel: [{ id: 'x9', receiptTotalCents: 5 }],
        });
        expect(written().records).toEqual([{ ref: 'Receipt:r1', fields: ['receiptTotalCents'] }]);
    });

    it('writes nothing when the viewer matches no role (empty view)', async () => {
        mockAuth.mockResolvedValue({ type: 'unauthenticated' } as AuthResult);
        const route = handler('GET /api/__test__/fv/receipts/[id]', async () => ({ ReceiptView: { id: 'r1', receiptTotalCents: 1 } }));
        await route(request('http://localhost/api/__test__/fv/receipts/r1'), { params: Promise.resolve({ id: 'r1' }) });
        expect(mockRecord).not.toHaveBeenCalled();
    });

    it('returns an opaque 500 when the row cannot be written', async () => {
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        mockAuth.mockResolvedValue(session(1, true));
        mockRecord.mockRejectedValue(new Error('db down'));
        const res = await get(RECEIPTS, { ReceiptView: [{ id: 'r1', donorFirstName: 'Jane', receiptTotalCents: 1 }] });
        expect(res.status).toBe(500);
        expect(JSON.stringify(await res.json())).not.toContain('Jane');
        errorSpy.mockRestore();
    });
});

describe('own records', () => {
    it("writes nothing for a view of the viewer's own receipts only", async () => {
        mockAuth.mockResolvedValue(session(9));
        const res = await get(RECEIPTS, { ReceiptView: [{ id: 'r1', uploadedByUserId: 9, receiptTotalCents: 1200 }] });
        expect(res.status).toBe(200);
        expect(mockRecord).not.toHaveBeenCalled();
    });

    it("leaves a Board member's own receipt out of a list that shows others' too", async () => {
        mockAuth.mockResolvedValue(session(9, true));
        await get(RECEIPTS, {
            ReceiptView: [
                { id: 'mine', uploadedByUserId: 9, receiptTotalCents: 100 },
                { id: 'theirs', uploadedByUserId: 4, receiptTotalCents: 200 },
            ],
        });
        expect(written().records.map(r => r.ref)).toEqual(['Receipt:theirs']);
    });

    const ctx = (over: Partial<CallerContext> = {}): CallerContext => ({
        selfId: 9,
        householdId: 50,
        isKeyholder: false,
        isKiosk: false,
        programsLed: new Set(),
        programsCoreVolIn: new Set(),
        participantIdsInScopePrograms: new Set(),
        householdIdsInScopePrograms: new Set(),
        eventIdsInScopePrograms: new Set(),
        activeVisitorIds: new Set(),
        ledHouseholdMemberIds: new Set(),
        householdMemberIds: new Set([9, 10]),
        ...over,
    });

    it.each([
        ['their own enrolment', 'ProgramParticipant', { programId: 1, personId: 9 }, true],
        ["a household member's enrolment, lead or not", 'ProgramParticipant', { programId: 1, personId: 10 }, true],
        ["another family's enrolment", 'ProgramParticipant', { programId: 1, personId: 11 }, false],
        ["a household member's membership process", 'OrgMembershipProcess', { id: 3, subjectPersonId: 10 }, true],
        ["the household's own membership process", 'OrgMembershipProcess', { id: 3, subjectPersonId: null, requestedForHouseholdId: 50 }, true],
        ["another household's membership process", 'OrgMembershipProcess', { id: 3, subjectPersonId: 11, requestedForHouseholdId: 51 }, false],
    ])('%s', (_label, model, row, own) => {
        expect(isOwnRow(model, row, ctx())).toBe(own);
    });

    it('treats nothing as household-owned when the members were not fetched', () => {
        expect(isOwnRow('ProgramParticipant', { programId: 1, personId: 10 }, ctx({ householdMemberIds: undefined }))).toBe(false);
    });
});

describe('record names', () => {
    it('defaults to the row\'s own model and id', () => {
        expect(rowRecords('Transaction', { id: 7, donationAmountCents: 100 }, [], {})).toEqual([
            { ref: 'Transaction:7', fields: ['donationAmountCents'] },
        ]);
    });

    it('names nothing for a key that only annotates another key\'s rows', () => {
        expect(rowRecords('ExpenseWaitingOn', { expenseId: 'e_1', label: 'Waiting on finance' }, [], {})).toEqual([]);
    });

    it('names a pointer field and an outside system', () => {
        const row = { id: 3, disbursementId: 'BEN-889', transactionId: 'T-1', transaction: { companyName: 'Acme' } };
        expect(
            rowRecords('DisbursementHold', row, [
                { key: 'DisbursementHold', id: 'disbursementId', model: 'Benevity.Disbursement' },
                { key: 'DisbursementHold', id: 'transactionId', model: 'Transaction' },
            ], {}),
        ).toEqual([
            { ref: 'Benevity.Disbursement:BEN-889', fields: ['transaction.companyName'] },
            { ref: 'Transaction:T-1', fields: ['transaction.companyName'] },
        ]);
    });

    it('joins several fields into one id', () => {
        expect(
            rowRecords('ProgramParticipant', { programId: 12, personId: 345, isPaymentPlanRequested: true }, [
                { key: 'ProgramParticipant', id: ['programId', 'personId'], model: 'ProgramParticipant' },
            ], {}),
        ).toEqual([{ ref: 'ProgramParticipant:12:345', fields: ['isPaymentPlanRequested'] }]);
    });

    it('names a path param', () => {
        expect(
            rowRecords('ExpenseQueueReason', { code: 'TAX', amountCents: 500 }, [
                { key: 'ExpenseQueueReason', id: { param: 'id' }, model: 'Expense' },
            ], { id: 'e_123' }),
        ).toEqual([{ ref: 'Expense:e_123', fields: ['amountCents'] }]);
    });

    it('picks the model from a field, and keeps an unknown value under its raw name', () => {
        const bySource = { field: 'source', map: { receipt: 'InKindDonation', manual: 'ManualInKindDonation' } };
        const decl = [{ key: 'InKindQueueItemView' as const, id: 'id', model: bySource }];
        expect(rowRecords('InKindQueueItemView', { id: 5, source: 'manual', totalValueCents: 1 }, decl, {})[0].ref).toBe('ManualInKindDonation:5');
        expect(rowRecords('InKindQueueItemView', { id: 5, source: 'receipt', totalValueCents: 1 }, decl, {})[0].ref).toBe('InKindDonation:5');
        expect(rowRecords('InKindQueueItemView', { id: 5, source: 'barter', totalValueCents: 1 }, decl, {})[0].ref).toBe('unknown-source:barter:5');
    });

    it('names every receipt the duplicate review displays', () => {
        const group = { dismissed: ['r7'], members: [{ id: 'r2', copyOfId: 'r1', uploaderName: 'Pat' }] };
        const refs = rowRecords('ReceiptDuplicateGroup', group, getRoute('GET /api/receipts/[id]/duplicate-group')?.financeView?.records ?? [], { id: 'r1' })
            .map(r => r.ref);
        expect(new Set(refs)).toEqual(new Set(['Receipt:r1', 'Receipt:r2', 'Receipt:r7']));
    });

    it("names a receipt's change history as the receipt", () => {
        const declarations = getRoute('GET /api/receipts/[id]/audit-logs')?.financeView?.records ?? [];
        expect(rowRecords('ReceiptAuditLog', { id: 41, receiptId: 'r9', valueAfter: '1200' }, declarations, { id: 'r9' })).toEqual([
            { ref: 'Receipt:r9', fields: ['valueAfter'] },
        ]);
    });

    it('keeps marked fields no record could take under unnamed:<key>', () => {
        expect(
            rowRecords('FinanceQueueRow', { expenseId: null, amountCents: 900 }, [
                { key: 'FinanceQueueRow', id: 'expenseId', model: 'Expense' },
                { key: 'FinanceQueueRow', id: 'receiptId', model: 'Receipt' },
            ], {}),
        ).toEqual([{ ref: 'unnamed:FinanceQueueRow', fields: ['amountCents'] }]);
    });
});

describe('the match audit (follow-up from #2683)', () => {
    it('logs a Board view naming the order, membership and enrolment behind each row', async () => {
        mockAuth.mockResolvedValue(session(1, true));
        const res = await get('GET /api/finance-ops/s-read/match-audit', {
            MatchAuditReport: {
                configured: true,
                orders: [{ bucket: 'UNCLAIMED_PAID', orderLegacyId: '1001', name: '#1001', customerEmail: 'buyer@x', totalCents: 500, discountCodes: [] }],
                memberships: [
                    { bucket: 'MANUAL_PAYMENT', processId: 9, membershipId: null, householdName: 'Lee', manualPaymentByName: 'Pat' },
                    { bucket: 'NO_PROCESS', processId: null, membershipId: 31, householdName: 'Kim' },
                ],
                enrollments: [{ bucket: 'ADMIN_COMPED', programId: 4, personId: 2, personName: 'Sam' }],
            },
        }, { params: {}, url: 'http://localhost/api/finance-ops/s-read/match-audit' });
        expect(res.status).toBe(200);
        expect(written().records).toEqual([
            { ref: 'OrgMembership:31', fields: ['memberships.householdName'] },
            { ref: 'OrgMembershipProcess:9', fields: ['memberships.householdName', 'memberships.manualPaymentByName'] },
            { ref: 'ProgramParticipant:4:2', fields: ['enrollments.personName'] },
            { ref: 'ShopOrder:1001', fields: ['orders.customerEmail', 'orders.discountCodes', 'orders.totalCents'] },
        ]);
    });
});

describe('page-view header', () => {
    const EXPENSE = 'GET /api/expense/expenses/[id]';
    const tagged = (path: string, id = 'pv_1') => ({ headers: new Headers({ [PAGE_VIEW_ID_HEADER]: id, [PAGE_VIEW_PATH_HEADER]: path }) });

    it('tags a call from a route on its page\'s list', () => {
        expect(pageViewTag(tagged('/expense/expenses/e_123'), EXPENSE)).toEqual({ id: 'pv_1', path: '/expense/expenses/e_123' });
        expect(pageViewTag(tagged('/finance/review'), 'GET /api/expense/finance-queue')).toEqual({ id: 'pv_1', path: '/finance/review' });
    });

    it.each([
        ['a route not on the page\'s list', tagged('/expense/expenses/e_123'), 'GET /api/donations/transactions'],
        ['a page not in the allowlist', tagged('/donations'), 'GET /api/donations/transactions'],
        ['a malformed id', tagged('/expense/expenses/e_123', 'bad id!'), EXPENSE],
        ['a path with a query string', tagged('/expense/expenses/e_123?x=1'), EXPENSE],
        ['a protocol-relative path', tagged('//evil/expense/expenses/e_123'), EXPENSE],
        ['no header', { headers: new Headers() }, EXPENSE],
    ])('leaves %s untagged', (_label, req, endpoint) => {
        expect(pageViewTag(req, endpoint)).toBeNull();
    });

    it('an allowlist miss writes an untagged row', async () => {
        mockAuth.mockResolvedValue(session(1, true));
        await get(RECEIPTS, { ReceiptView: { id: 'r1', receiptTotalCents: 1 } }, {
            headers: { [PAGE_VIEW_ID_HEADER]: 'pv_1', [PAGE_VIEW_PATH_HEADER]: '/expense/expenses/e_123' },
        });
        expect(written().pageView).toBeNull();
    });

    it('the allowlist names only registered GET routes', () => {
        expect(pageViewFoldErrors()).toEqual([]);
    });

    describe('merging limits (enforced by the writer)', () => {
        const call = { actorId: 1, pageView: { id: 'pv_1', path: '/expense/expenses/e_123' } };
        it('merges the same person on the same path', () => {
            expect(pageViewDisposition(call, { actorId: 1, pagePath: '/expense/expenses/e_123' }, true)).toBe('merge');
        });
        it('starts a new page view once the open row has closed', () => {
            expect(pageViewDisposition(call, { actorId: 1, pagePath: '/expense/expenses/e_123' }, false)).toBe('new');
        });
        it("never joins another person's id", () => {
            expect(pageViewDisposition(call, { actorId: 2, pagePath: '/expense/expenses/e_123' }, true)).toBe('untagged');
        });
        it("never joins the id's first page under another path", () => {
            expect(pageViewDisposition(call, { actorId: 1, pagePath: '/expense/expenses/e_999' }, true)).toBe('untagged');
        });
    });
});

describe('fileHandler — logging from marks', () => {
    const BYTES = new Uint8Array([0x68, 0x69]);
    function getFile(endpoint: string, row: Record<string, unknown>) {
        const route = fileHandler(endpoint, async () => ({ row, contentType: 'text/plain' }));
        return route(new NextRequest('http://localhost/api/__test__/fv/receipt-file/r9'), { params: Promise.resolve({ id: 'r9' }) });
    }

    it('logs a marked file served to someone other than its owner', async () => {
        mockAuth.mockResolvedValue(session(1, true));
        expect((await getFile(FILE, { id: 'r9', uploadedByUserId: 4, fileBlob: BYTES })).status).toBe(200);
        expect(written().records).toEqual([{ ref: 'Receipt:r9', fields: ['fileBlob'] }]);
    });

    it("writes nothing when the owner fetches their own file", async () => {
        mockAuth.mockResolvedValue(session(4));
        expect((await getFile(FILE, { id: 'r9', uploadedByUserId: 4, fileBlob: BYTES })).status).toBe(200);
        expect(mockRecord).not.toHaveBeenCalled();
    });

    it('writes nothing for an unmarked file field', async () => {
        mockAuth.mockResolvedValue(session(1, true));
        expect((await getFile(UNMARKED_FILE, { id: 3, email: BYTES })).status).toBe(200);
        expect(mockRecord).not.toHaveBeenCalled();
    });

    it('returns an opaque 500 when the row cannot be written', async () => {
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        mockAuth.mockResolvedValue(session(1, true));
        mockRecord.mockRejectedValue(new Error('db down'));
        expect((await getFile(FILE, { id: 'r9', uploadedByUserId: 4, fileBlob: BYTES })).status).toBe(500);
        errorSpy.mockRestore();
    });
});

describe('start-up checks on declarations', () => {
    const base: Pick<RouteSpec, 'endpoint' | 'orderedView' | 'returns'> = {
        endpoint: 'GET /api/__test__/fv/check/[id]',
        orderedView: [['isBoardMember', FULL]],
        returns: ['FinanceQueueRow'],
    };

    it('refuses id-less rows that can carry a marked field with no declaration', () => {
        expect(financeViewErrors(base)).toEqual([
            'FinanceQueueRow can carry a marked field on rows with no id; declare its records',
        ]);
    });

    it('refuses a declared field that is not classified on its model', () => {
        expect(financeViewErrors({ ...base, financeView: { records: [{ key: 'FinanceQueueRow', id: 'nope', model: 'Expense' }] } }))
            .toContain('FinanceQueueRow: id field FinanceQueueRow.nope is not classified');
    });

    it('refuses a model that is neither classified nor an outside name', () => {
        expect(financeViewErrors({ ...base, financeView: { records: [{ key: 'FinanceQueueRow', id: 'expenseId', model: 'Stripe.Charge' }] } }))
            .toContain("FinanceQueueRow: model 'Stripe.Charge' is neither classified nor an outside name");
    });

    it('refuses an id a role that sees a marked field cannot see', () => {
        const spec = {
            ...base,
            returns: ['ReceiptView' as const],
            orderedView: [['authenticated', ['everyones:internal']]] as const,
            financeView: { records: [{ key: 'ReceiptView' as const, id: 'copyOfId', model: 'Receipt' }] },
        };
        expect(financeViewErrors(spec)).toContain(
            "ReceiptView: role 'authenticated' can see a marked field on ReceiptView but not ReceiptView.copyOfId",
        );
    });

    it('refuses a param the endpoint does not have', () => {
        expect(financeViewErrors({ ...base, financeView: { records: [{ key: 'FinanceQueueRow', id: { param: 'gid' }, model: 'Expense' }] } }))
            .toContain("FinanceQueueRow: param 'gid' is not in the endpoint path");
    });

    it('refuses a declaration on a write', () => {
        expect(financeViewErrors({ ...base, endpoint: 'POST /api/__test__/fv/check', financeView: {} }))
            .toEqual(['financeView is allowed only on a GET endpoint']);
    });

    it('refuses to register a route with a bad declaration', () => {
        expect(() => defineRoute({ ...base, endpoint: 'GET /api/__test__/fv/bad', authorize: 'authenticated', envelope: null }))
            .toThrow(/bad finance-view declaration/);
    });

    it('every mark is on a classified field', () => {
        expect(markErrors()).toEqual([]);
    });
});

describe('routes Q17 stops logging', () => {
    it.each([
        'GET /api/income/items',
        'GET /api/expense/provisional-items',
        'GET /api/expense/qb-exclusions',
        'GET /api/income/qb-exclusions',
        'GET /api/receipts/ignored-files',
        'GET /api/expense/expenses/[id]/signoffs',
        'GET /api/expense/expenses/[id]/line-item-approvals',
    ])('%s sends no marked field', endpoint => {
        const spec = getRoute(endpoint);
        expect(spec).toBeDefined();
        expect((spec?.returns ?? []).filter(model => (marks[model] ?? []).length > 0)).toEqual([]);
    });
});

describe('routes audited before field marks still log', () => {
    // Every route that carried `auditedRead` before marks replaced it, apart from those
    // the doc's "Routes no longer logged" table names. Unmarking a field these depend on fails here.
    const STILL_LOGGED = [
    'GET /api/donations/comment-rules',
    'GET /api/donations/disbursement-events',
    'GET /api/donations/disbursement-holds',
    'GET /api/donations/in-kind/by-bucket',
    'GET /api/donations/in-kind/manual',
    'GET /api/donations/in-kind/manual/[id]',
    'GET /api/donations/in-kind/queue',
    'GET /api/donations/in-kind/receipt/[id]',
    'GET /api/donations/transactions',
    'GET /api/donations/transactions/[id]',
    'GET /api/donations/transactions/unassigned',
    'GET /api/donations/uploaded-files',
    'GET /api/donations/uploaded-files/[id]/blob',
    'GET /api/expense/donated-capital',
    'GET /api/expense/expense-events',
    'GET /api/expense/expenses',
    'GET /api/expense/expenses/[id]',
    'GET /api/expense/expenses/[id]/qb-candidates',
    'GET /api/expense/expenses/[id]/reimbursee-vendor',
    'GET /api/expense/finance-queue',
    'GET /api/expense/queue',
    'GET /api/expense/received-expense-payloads',
    'GET /api/finance-ops/membership-payment-plans',
    'GET /api/finance-ops/payment-plans',
    'GET /api/finance-ops/payments',
    'GET /api/income/payouts',
    'GET /api/income/payouts/[gid]',
    'GET /api/income/reconciliation',
    'GET /api/income/reconciliation/[id]/candidates',
    'GET /api/receipts',
    'GET /api/receipts/[id]',
    'GET /api/receipts/[id]/audit-logs',
    'GET /api/receipts/[id]/duplicate-group',
    'GET /api/receipts/[id]/file',
    'GET /api/receipts/confirmations',
    'GET /api/receipts/duplicate-queue',
    'GET /api/receipts/mail-items',
    'GET /api/receipts/mail-items/[id]/file',
    'GET /api/receipts/needs-attention',
    'GET /api/workflow-mapping/audit-log',
    'GET /api/workflow-mapping/receipts',
    'GET /api/workflow-mapping/receipts/[id]',
    ];

    it.each(STILL_LOGGED)('%s can send a marked field', endpoint => {
        const route = getRoute(endpoint);
        const file = getFileRoute(endpoint);
        expect(route ?? file).toBeDefined();
        const logs = route
            ? (route.returns ?? []).some(model => route.orderedView.some(([, tokens]) => marksVisible(tokens, model)))
            : file !== undefined && (marks[file.file.model] ?? []).includes(file.file.field);
        expect(logs).toBe(true);
    });
});
