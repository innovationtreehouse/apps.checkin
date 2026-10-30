/**
 * @jest-environment node
 *
 * B11 contract: an `auditedRead` route writes one finance-view row when a view
 * reaching others' rows returns rows, writes none otherwise, and refuses the
 * response when the row cannot be written. The writer itself (window, key,
 * repeats) is covered by its own tests.
 */
import type { NextRequest as NextRequestType } from 'next/server';
import type { AuthResult } from '@/types/auth';
import { defineFileRoute, defineRoute, type OrderedViewEntry } from '@/security/core';
import { handler, type ModelBag } from '@/security/handler';
import { fileHandler } from '@/security/fileHandler';
import { authenticateRequest } from '@/lib/auth';
import { recordFinanceView } from '@/lib/finance/financeViewLog';

jest.mock('@/lib/auth', () => ({ authenticateRequest: jest.fn() }));
jest.mock('@/lib/finance/financeViewLog', () => ({ recordFinanceView: jest.fn() }));
// jest.setup.js stubs next/server down to NextResponse.json; the request class is the real one.
const { NextRequest } = jest.requireActual<{ NextRequest: typeof NextRequestType }>('next/server');
const mockAuth = authenticateRequest as jest.MockedFunction<typeof authenticateRequest>;
const mockRecord = recordFinanceView as jest.MockedFunction<typeof recordFinanceView>;

// Person.id is `public` and binds `their_own`, so a row with the caller's id is their own.
const VIEW: readonly OrderedViewEntry[] = [
    ['isBoardMember', ['everyones:pii', 'public']],
    ['authenticated', ['their_own:pii', 'public']],
];
const ENDPOINT = 'GET /api/__test__/audited/[id]';
const BOARD_ONLY = 'GET /api/__test__/audited-board-only';
const UNAUDITED = 'GET /api/__test__/unaudited';
const PAYOUTS = 'GET /api/__test__/audited-payouts';
const FILE = 'GET /api/__test__/audited-file/[id]';

defineRoute({ endpoint: ENDPOINT, authorize: 'authenticated', envelope: null, returns: ['Person'], orderedView: VIEW, auditedRead: true });
defineRoute({ endpoint: BOARD_ONLY, authorize: 'authenticated', envelope: null, returns: ['Person'], orderedView: [['isBoardMember', ['everyones:pii', 'public']]], auditedRead: true });
defineRoute({ endpoint: UNAUDITED, authorize: 'authenticated', envelope: null, returns: ['Person'], orderedView: VIEW });
defineRoute({ endpoint: PAYOUTS, authorize: 'authenticated', envelope: null, returns: ['IncomePayoutView'], orderedView: [['isBoardMember', ['everyones:internal', 'public']]], auditedRead: true });
defineFileRoute({ endpoint: FILE, authorize: 'authenticated', orderedView: VIEW, file: { model: 'Person', field: 'email' }, auditedRead: true });

function session(id: number, isBoardMember = false): AuthResult {
    return {
        type: 'session',
        user: {
            id,
            isSysadmin: false,
            isBoardMember,
            isKeyholder: false,
            isBackgroundCheckReviewer: false,
            isOperations: false,
        },
    } as AuthResult;
}

function get(endpoint: string, bag: ModelBag, params: Record<string, string> = {}) {
    const route = handler(endpoint, async () => bag);
    return route(new NextRequest('http://localhost/api/__test__/x?q=Jane%20Donor'), { params: Promise.resolve(params) });
}

beforeEach(() => {
    mockAuth.mockReset();
    mockRecord.mockReset();
    mockRecord.mockResolvedValue(undefined);
});

describe('handler — auditedRead', () => {
    it('writes one row naming the viewer, role, endpoint, params and returned ids', async () => {
        mockAuth.mockResolvedValue(session(1, true));
        const res = await get(ENDPOINT, { Person: [{ id: 3, email: 'a@x' }, { id: 4, email: 'b@x' }] }, { id: '3' });
        expect(res.status).toBe(200);
        expect(mockRecord).toHaveBeenCalledTimes(1);
        expect(mockRecord).toHaveBeenCalledWith({
            actorId: 1,
            role: 'isBoardMember',
            endpoint: ENDPOINT,
            params: { id: '3' },
            recordIds: ['3', '4'],
            rowCount: 2,
        });
    });

    it('records neither the query string nor any field value', async () => {
        mockAuth.mockResolvedValue(session(1, true));
        await get(ENDPOINT, { Person: { id: 3, email: 'a@x' } }, { id: '3' });
        const written = JSON.stringify(mockRecord.mock.calls[0][0]);
        expect(written).not.toContain('Jane');
        expect(written).not.toContain('a@x');
    });

    it('counts a row without an id but records no id for it', async () => {
        mockAuth.mockResolvedValue(session(1, true));
        await get(ENDPOINT, { Person: [{ id: 3 }, { email: 'b@x' }] }, { id: '3' });
        expect(mockRecord).toHaveBeenCalledWith(expect.objectContaining({ recordIds: ['3'], rowCount: 2 }));
    });

    it("records a store payout by its payoutGid", async () => {
        mockAuth.mockResolvedValue(session(1, true));
        await get(PAYOUTS, { IncomePayoutView: [{ payoutGid: 'gid://shopify/Payout/9', netCents: 100 }] });
        expect(mockRecord).toHaveBeenCalledWith(expect.objectContaining({ recordIds: ['gid://shopify/Payout/9'], rowCount: 1 }));
    });

    it("writes nothing for a view of the caller's own rows only", async () => {
        mockAuth.mockResolvedValue(session(3));
        const res = await get(ENDPOINT, { Person: [{ id: 3, email: 'me@x' }] }, { id: '3' });
        expect(res.status).toBe(200);
        expect(mockRecord).not.toHaveBeenCalled();
    });

    it('writes nothing when the bag holds no rows', async () => {
        mockAuth.mockResolvedValue(session(1, true));
        const res = await get(ENDPOINT, { Person: [] }, { id: '3' });
        expect(res.status).toBe(200);
        expect(mockRecord).not.toHaveBeenCalled();
    });

    it('writes nothing for a caller matching no role (empty token list)', async () => {
        mockAuth.mockResolvedValue(session(1));
        const res = await get(BOARD_ONLY, { Person: [{ id: 3, email: 'a@x' }] });
        expect(res.status).toBe(200);
        expect(mockRecord).not.toHaveBeenCalled();
    });

    it('writes nothing on a route without the flag', async () => {
        mockAuth.mockResolvedValue(session(1, true));
        await get(UNAUDITED, { Person: [{ id: 3 }] });
        expect(mockRecord).not.toHaveBeenCalled();
    });

    it('returns an opaque 500 when the row cannot be written', async () => {
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        mockAuth.mockResolvedValue(session(1, true));
        mockRecord.mockRejectedValue(new Error('db down'));
        const res = await get(ENDPOINT, { Person: [{ id: 3, email: 'a@x' }] }, { id: '3' });
        expect(res.status).toBe(500);
        expect(JSON.stringify(await res.json())).not.toContain('a@x');
        errorSpy.mockRestore();
    });
});

describe('fileHandler — auditedRead', () => {
    const BYTES = new Uint8Array([0x68, 0x69]);
    function getFile(row: Record<string, unknown>) {
        const route = fileHandler(FILE, async () => ({ row, contentType: 'text/plain' }));
        return route(new NextRequest('http://localhost/api/__test__/audited-file/9'), { params: Promise.resolve({ id: '9' }) });
    }

    it('writes one row with rowCount 1 and the row id', async () => {
        mockAuth.mockResolvedValue(session(1, true));
        const res = await getFile({ id: 7, email: BYTES });
        expect(res.status).toBe(200);
        expect(mockRecord).toHaveBeenCalledWith({
            actorId: 1,
            role: 'isBoardMember',
            endpoint: FILE,
            params: { id: '9' },
            recordIds: ['7'],
            rowCount: 1,
        });
    });

    it('falls back to the [id] path param when the row has no id', async () => {
        mockAuth.mockResolvedValue(session(1, true));
        await getFile({ email: BYTES });
        expect(mockRecord).toHaveBeenCalledWith(expect.objectContaining({ recordIds: ['9'], rowCount: 1 }));
    });

    it("writes nothing when the caller fetches their own file", async () => {
        mockAuth.mockResolvedValue(session(7));
        expect((await getFile({ id: 7, email: BYTES })).status).toBe(200);
        expect(mockRecord).not.toHaveBeenCalled();
    });

    it('returns an opaque 500 when the row cannot be written', async () => {
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        mockAuth.mockResolvedValue(session(1, true));
        mockRecord.mockRejectedValue(new Error('db down'));
        expect((await getFile({ id: 7, email: BYTES })).status).toBe(500);
        errorSpy.mockRestore();
    });
});

describe('registration — auditedRead', () => {
    it('rejects the flag on a non-GET endpoint', () => {
        expect(() =>
            defineRoute({ endpoint: 'POST /api/__test__/audited-write', authorize: 'authenticated', envelope: null, orderedView: VIEW, auditedRead: true }),
        ).toThrow(/auditedRead is allowed only on a GET endpoint/);
    });
});
