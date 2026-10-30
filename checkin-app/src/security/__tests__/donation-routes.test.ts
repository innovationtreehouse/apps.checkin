/**
 * @jest-environment node
 *
 * Admission and file-only coverage for the bulk-donation registry (#1280,
 * registry/donation.ts). Reads admit FINANCE or BOARD, writes FINANCE only,
 * except the in-kind decision, which admits FINANCE or BOARD. Ops (OPERATIONS,
 * INVENTORY_MANAGER) reaches only the no-receipt in-kind entry routes, and never
 * sees a donor. A bucket approver (its owner or a treasurer) reaches only the
 * by-bucket read, and never sees a donor. Sysadmin, a plain session, an id-less
 * session and no session are refused on every route. UploadedFile.fileBlob
 * leaves only through the file route.
 *
 * Callers sign in through the real authenticateRequest: only getServerSession
 * is mocked, so an id-less session takes the production path (plan rule 6).
 */
import type { NextRequest as NextRequestType } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { bucketsApprovedBy } from '@/lib/finance/bucketApprovers';
import type { AuthResult } from '@/types/auth';
import { allRoutes, getFileRoute, getRoute, isFileOnlyField } from '@/security/core';
import { handler } from '@/security/handler';
import { fileHandler } from '@/security/fileHandler';
import { buildCallerContext, resolveAccess } from '@/security/access-resolvers';
import '@/security/registry';

const { NextRequest } = jest.requireActual<{ NextRequest: typeof NextRequestType }>('next/server');
const mockSession = getServerSession as jest.MockedFunction<typeof getServerSession>;

type Flags = { isFinance?: boolean; isBoardMember?: boolean; isSysadmin?: boolean; isOperations?: boolean; isInventoryManager?: boolean; programsLed?: number[] };
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
const signIn = (id: unknown, flags: Flags = {}) => mockSession.mockResolvedValue({ user: user(id, flags) });

const ID_LESS = [undefined, null, '7'];
const FILE_ENDPOINT = 'GET /api/donations/uploaded-files/[id]/blob';
const BLOB = new Uint8Array([0x61, 0x2c, 0x62]);
const uploadedFile = () => ({ id: 1, orgId: 'treehouse', originalFilename: 'benevity.csv', fileBlob: BLOB });

const endpoints = [...allRoutes()].map(([e]) => e).filter(e => e.includes(' /api/donations/'));
const reads = endpoints.filter(e => e.startsWith('GET '));
const writes = endpoints.filter(e => !e.startsWith('GET '));
const DECISIONS = endpoints.filter(e => e.endsWith('/decision'));
const BY_BUCKET = 'GET /api/donations/in-kind/by-bucket';
const SETTLE = 'POST /api/donations/in-kind/receipt/[id]/settle';
const QB_RESOLVES = endpoints.filter(e => e.endsWith('/qb-resolve'));
const DETAILS = ['GET /api/donations/in-kind/receipt/[id]', 'GET /api/donations/in-kind/manual/[id]'];
const financeWrites = writes.filter(e => !DECISIONS.includes(e));
const IN_KIND_MANUAL = endpoints.filter(e => e.includes('/api/donations/in-kind/manual') && !DECISIONS.includes(e) && !DETAILS.includes(e) && !QB_RESOLVES.includes(e));
const OPS = [{ isOperations: true }, { isInventoryManager: true }];

async function callJson(endpoint: string) {
    const impl = jest.fn(async () => ({ UploadedFile: uploadedFile() }));
    const res = await handler(endpoint, impl)(new NextRequest('http://localhost/api/donations/x'), {
        params: Promise.resolve({ id: '1', disbursementId: 'D1' }),
    });
    return { status: res.status, impl, body: res.status === 200 ? await res.json() : undefined };
}

jest.mock('@/lib/finance/financeViewLog', () => ({ recordFinanceView: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/lib/finance/bucketApprovers', () => ({ bucketsApprovedBy: jest.fn() }));

let approvedBuckets: number[];

beforeEach(() => {
    mockSession.mockReset();
    approvedBuckets = [];
    jest.mocked(bucketsApprovedBy).mockReset();
    jest.mocked(bucketsApprovedBy).mockImplementation(async () => approvedBuckets);
});

describe('donation registry — shape', () => {
    it('registers 30 JSON routes (14 reads, 16 writes) and the blob file route', () => {
        expect(endpoints).toHaveLength(30);
        expect(reads).toHaveLength(14);
        expect(writes).toHaveLength(16);
        expect(DECISIONS).toEqual([
            'POST /api/donations/in-kind/receipt/[id]/decision',
            'POST /api/donations/in-kind/manual/[id]/decision',
        ]);
        expect(QB_RESOLVES).toEqual([
            'POST /api/donations/in-kind/receipt/[id]/qb-resolve',
            'POST /api/donations/in-kind/manual/[id]/qb-resolve',
        ]);
        expect(IN_KIND_MANUAL).toHaveLength(3);
        expect(endpoints.filter(e => e.includes('/qb-candidates') || e.includes('/qb-exclusions'))).toEqual([]);
        expect(getFileRoute(FILE_ENDPOINT)?.file).toEqual({ model: 'UploadedFile', field: 'fileBlob' });
    });

    it('no view on any donation route belongs to sysadmin', () => {
        const views = [...allRoutes()].filter(([e]) => endpoints.includes(e)).map(([, s]) => s.orderedView);
        views.push(getFileRoute(FILE_ENDPOINT)?.orderedView ?? []);
        for (const view of views) {
            expect(view.map(([role]) => role)).not.toContain('isSysadmin');
        }
    });
});

describe('donation registry — admission', () => {
    it.each(reads)('%s admits FINANCE and BOARD', async endpoint => {
        for (const flags of [{ isFinance: true }, { isBoardMember: true }]) {
            signIn(7, flags);
            expect((await callJson(endpoint)).status).toBe(200);
        }
    });

    it.each(DECISIONS)('%s admits FINANCE and BOARD', async endpoint => {
        for (const flags of [{ isFinance: true }, { isBoardMember: true }]) {
            signIn(7, flags);
            expect((await callJson(endpoint)).status).toBe(200);
        }
    });

    it.each(financeWrites)('%s admits FINANCE and refuses BOARD', async endpoint => {
        signIn(7, { isFinance: true });
        expect((await callJson(endpoint)).status).toBe(200);
        signIn(7, { isBoardMember: true });
        expect((await callJson(endpoint)).status).toBe(403);
    });

    it.each(endpoints)('%s refuses sysadmin and a plain session (403)', async endpoint => {
        for (const flags of [{ isSysadmin: true }, {}]) {
            signIn(7, flags);
            const { status, impl } = await callJson(endpoint);
            expect(status).toBe(403);
            expect(impl).not.toHaveBeenCalled();
        }
    });

    it.each(endpoints)('%s 401s no session and an id-less FINANCE+BOARD session', async endpoint => {
        mockSession.mockResolvedValue(null);
        expect((await callJson(endpoint)).status).toBe(401);
        for (const id of ID_LESS) {
            signIn(id, { isFinance: true, isBoardMember: true });
            const { status, impl } = await callJson(endpoint);
            expect(status).toBe(401);
            expect(impl).not.toHaveBeenCalled();
        }
    });

    // Second layer: an id-less session that reaches the gate anyway is denied there.
    it.each(endpoints)('%s: resolveAccess denies an id-less session', async endpoint => {
        const spec = getRoute(endpoint);
        if (!spec) throw new Error(`no registry entry for ${endpoint}`);
        for (const id of [...ID_LESS, 7.5]) {
            const auth = { type: 'session', user: user(id, { isFinance: true, isBoardMember: true }) } as AuthResult;
            const callerContext = await buildCallerContext(auth, spec.ctxNeeds);
            const { allowed } = await resolveAccess(spec.authorize, { auth, params: {}, callerContext });
            expect(allowed).toBe(false);
        }
    });
});

describe('no-receipt in-kind routes — ops', () => {
    it.each(IN_KIND_MANUAL)('%s admits OPERATIONS and INVENTORY_MANAGER', async endpoint => {
        for (const flags of OPS) {
            signIn(7, flags);
            expect((await callJson(endpoint)).status).toBe(200);
        }
    });

    it.each(endpoints.filter(e => !IN_KIND_MANUAL.includes(e)))('%s refuses ops (403)', async endpoint => {
        for (const flags of OPS) {
            signIn(7, flags);
            const { status, impl } = await callJson(endpoint);
            expect(status).toBe(403);
            expect(impl).not.toHaveBeenCalled();
        }
    });

    async function listAs(flags: Flags) {
        signIn(7, flags);
        const impl = jest.fn(async () => ({
            ManualInKindDonation: [{
                id: 1,
                donorFirstName: 'Pat',
                donorLastName: 'Doe',
                donorCompanyName: 'Acme',
                donationDate: '2026-10-01',
                lines: [{ id: 2, gtin13: '0000000000017', quantity: 3, valueCents: 900 }],
            }],
        }));
        const res = await handler('GET /api/donations/in-kind/manual', impl)(
            new NextRequest('http://localhost/api/donations/in-kind/manual'),
            { params: Promise.resolve({}) },
        );
        expect(res.status).toBe(200);
        return (await res.json())[0] as Record<string, unknown>;
    }

    it.each(OPS)('the list shows %p the goods with the donor stripped', async flags => {
        const row = await listAs(flags);
        expect(row).toMatchObject({ id: 1, donationDate: '2026-10-01', lines: [{ gtin13: '0000000000017', quantity: 3, valueCents: 900 }] });
        expect(row).not.toHaveProperty('donorFirstName');
        expect(row).not.toHaveProperty('donorLastName');
        expect(row).not.toHaveProperty('donorCompanyName');
    });

    it.each([{ isFinance: true }, { isBoardMember: true }, { isFinance: true, isOperations: true }])(
        'the list shows %p the donor',
        async flags => {
            expect(await listAs(flags)).toMatchObject({ donorFirstName: 'Pat', donorLastName: 'Doe', donorCompanyName: 'Acme' });
        },
    );
});

describe('UploadedFile.fileBlob is file-only', () => {
    it('is a file-only field', () => {
        expect(isFileOnlyField('UploadedFile', 'fileBlob')).toBe(true);
    });

    it.each(endpoints)('%s never returns fileBlob, even to FINANCE (pii view)', async endpoint => {
        signIn(7, { isFinance: true });
        const { status, body } = await callJson(endpoint);
        expect(status).toBe(200);
        expect(body).toHaveProperty('originalFilename', 'benevity.csv');
        expect(body).not.toHaveProperty('fileBlob');
    });

    async function callFile() {
        const impl = jest.fn(async () => ({
            row: uploadedFile(),
            contentType: 'text/plain' as const,
            filename: 'benevity.csv',
        }));
        const res = await fileHandler(FILE_ENDPOINT, impl)(
            new NextRequest('http://localhost/api/donations/uploaded-files/1/blob'),
            { params: Promise.resolve({ id: '1' }) },
        );
        return { res, impl };
    }

    it.each([{ isFinance: true }, { isBoardMember: true }])(
        'the blob route serves %p the CSV as a text/plain attachment',
        async flags => {
            signIn(7, flags);
            const { res } = await callFile();
            expect(res.status).toBe(200);
            expect(new Uint8Array(await res.arrayBuffer())).toEqual(BLOB);
            expect(res.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
            expect(res.headers.get('Content-Disposition')).toMatch(/^attachment;/);
        },
    );

    it('the blob route refuses sysadmin and a plain session (403)', async () => {
        for (const flags of [{ isSysadmin: true }, {}]) {
            signIn(7, flags);
            const { res, impl } = await callFile();
            expect(res.status).toBe(403);
            expect(impl).not.toHaveBeenCalled();
        }
    });

    it.each(ID_LESS)('the blob route 401s an id-less session (id = %p)', async id => {
        signIn(id, { isFinance: true });
        const { res, impl } = await callFile();
        expect(res.status).toBe(401);
        expect(impl).not.toHaveBeenCalled();
    });
});

describe('in-kind decision, settle, qb-resolve and by-bucket routes never grant pii', () => {
    it.each([...DECISIONS, SETTLE, ...QB_RESOLVES, BY_BUCKET])('%s: no view holds a pii token', endpoint => {
        const tokens = (getRoute(endpoint)?.orderedView ?? []).flatMap(([, t]) => [...t]);
        expect(tokens.length).toBeGreaterThan(0);
        expect(tokens.some(t => t.endsWith(':pii'))).toBe(false);
    });
});

describe('in-kind by-bucket route — bucket approvers', () => {
    async function listAs(flags: Flags) {
        signIn(7, flags);
        const impl = jest.fn(async () => ({
            InKindBucketGiftView: [{
                id: 1,
                source: 'manual',
                budgetOwnerId: 4,
                donationDate: '2026-10-01',
                totalValueCents: 900,
                donorFirstName: 'Pat',
                donorLastName: 'Doe',
                donorCompanyName: 'Acme',
                lines: [{ id: 2, gtin13: null, description: 'Bench vise', quantity: 3, valueCents: 900, donorLastName: 'Doe' }],
            }],
        }));
        const res = await handler(BY_BUCKET, impl)(
            new NextRequest('http://localhost/api/donations/in-kind/by-bucket'),
            { params: Promise.resolve({}) },
        );
        return { status: res.status, impl, row: res.status === 200 ? (await res.json())[0] as Record<string, unknown> : undefined };
    }

    it('admits a bucket approver and shows the gift without the donor', async () => {
        approvedBuckets = [4];
        const { status, row } = await listAs({});
        expect(status).toBe(200);
        expect(row).toEqual({
            id: 1,
            source: 'manual',
            budgetOwnerId: 4,
            donationDate: '2026-10-01',
            totalValueCents: 900,
            lines: [{ id: 2, gtin13: null, description: 'Bench vise', quantity: 3, valueCents: 900 }],
        });
    });

    it('refuses a program leader who approves no bucket', async () => {
        expect((await listAs({ programsLed: [4] })).status).toBe(403);
    });

    it.each([{ isFinance: true }, { isBoardMember: true }])('shows %p the gift without the donor', async flags => {
        const { status, row } = await listAs(flags);
        expect(status).toBe(200);
        expect(row).not.toHaveProperty('donorFirstName');
        expect(row).not.toHaveProperty('donorLastName');
        expect(row).not.toHaveProperty('donorCompanyName');
    });

    it.each(endpoints.filter(e => e !== BY_BUCKET))('%s refuses a bucket approver (403)', async endpoint => {
        approvedBuckets = [4];
        signIn(7, {});
        const { status, impl } = await callJson(endpoint);
        expect(status).toBe(403);
        expect(impl).not.toHaveBeenCalled();
    });
});

describe('in-kind decision routes', () => {
    it.each(DECISIONS)('%s replies with the decision and no donor', async endpoint => {
        signIn(7, { isBoardMember: true });
        const decision = {
            id: 3,
            source: 'receipt',
            giftId: 1,
            outcome: 'ACCEPTED',
            decidedByUserId: 7,
            decidedAt: '2026-10-16T00:00:00.000Z',
            budgetOwnerId: 4,
            totalValueCents: 900,
        };
        const impl = jest.fn(async () => ({ InKindDecisionView: { ...decision, donorLastName: 'Doe' } }));
        const res = await handler(endpoint, impl)(
            new NextRequest('http://localhost/api/donations/in-kind/x/1/decision', { method: 'POST' }),
            { params: Promise.resolve({ id: '1' }) },
        );
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual(decision);
    });
});

describe('in-kind settle route', () => {
    it('replies to finance with the settle result and no donor', async () => {
        signIn(7, { isFinance: true });
        const settled = { id: 1, kind: 'withdrawal', settledAt: '2026-10-17T00:00:00.000Z' };
        const impl = jest.fn(async () => ({ InKindSettleResult: { ...settled, donorLastName: 'Doe' } }));
        const res = await handler(SETTLE, impl)(
            new NextRequest('http://localhost/api/donations/in-kind/receipt/1/settle', { method: 'POST' }),
            { params: Promise.resolve({ id: '1' }) },
        );
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual(settled);
    });
});

describe('in-kind qb-resolve routes', () => {
    it.each(QB_RESOLVES)('%s replies to finance with the queue item and no donor', async endpoint => {
        signIn(7, { isFinance: true });
        const item = { id: 1, source: 'receipt', state: 'ready', revenueBooking: 'matched', expenseBooking: 'unbooked', qbState: 'skipped', qbNote: 'booked by hand', lines: [] };
        const impl = jest.fn(async () => ({ InKindQueueItemView: { ...item, donorLastName: 'Doe' } }));
        const res = await handler(endpoint, impl)(
            new NextRequest('http://localhost/api/donations/in-kind/x/1/qb-resolve', { method: 'POST' }),
            { params: Promise.resolve({ id: '1' }) },
        );
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual(item);
    });
});

describe('in-kind gift detail routes', () => {
    const gift = {
        id: 1,
        source: 'manual',
        receiptId: null,
        donationDate: '2026-10-01',
        recordedByUsername: 'ops',
        outcome: 'ACCEPTED',
        state: null,
        waitingOn: [],
        inventorySourceKey: 'donation:1',
        inventoryLoadedAt: '2026-10-01T12:00:00.000Z',
        lines: [{ id: 2, gtin13: '0000000000017', description: 'Bench vise', quantity: 3, valueCents: 900, suggestedValueCents: 800 }],
        events: [{ id: 5, eventType: 'IN_KIND_DECIDED', actorUsername: 'fin', occurredAt: '2026-10-02T00:00:00.000Z', payload: '{"outcome":"ACCEPTED"}' }],
    };
    const donor = { donorFirstName: 'Pat', donorLastName: 'Doe', donorCompanyName: 'Acme' };

    async function getAs(endpoint: string, flags: Flags) {
        signIn(7, flags);
        const impl = jest.fn(async () => ({
            InKindGiftDetailView: {
                ...gift,
                ...donor,
                uploadedByUserId: 9,
                lines: [{ ...gift.lines[0], donorLastName: 'Doe' }],
                events: [{ ...gift.events[0], actorUserId: 7, orgId: 'treehouse' }],
            },
        }));
        const res = await handler(endpoint, impl)(
            new NextRequest('http://localhost/api/donations/in-kind/x/1'),
            { params: Promise.resolve({ id: '1' }) },
        );
        return { status: res.status, body: res.status === 200 ? await res.json() : undefined };
    }

    it.each(DETAILS.flatMap(e => [{ isFinance: true }, { isBoardMember: true }].map(flags => [e, flags] as const)))(
        '%s shows %p the gift with its donor, lines and history and nothing else',
        async (endpoint, flags) => {
            const { status, body } = await getAs(endpoint, flags);
            expect(status).toBe(200);
            expect(body).toEqual({ ...gift, ...donor });
        },
    );
});
