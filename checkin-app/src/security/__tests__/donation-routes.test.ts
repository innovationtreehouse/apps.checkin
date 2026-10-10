/**
 * @jest-environment node
 *
 * Admission and file-only coverage for the bulk-donation registry (#1280 §5,
 * registry/donation.ts). Reads admit FINANCE or BOARD, writes FINANCE only;
 * sysadmin, a plain session, an id-less session and no session are refused on
 * every route. UploadedFile.fileBlob leaves only through the file route.
 *
 * Callers sign in through the real authenticateRequest: only getServerSession
 * is mocked, so an id-less session takes the production path (plan rule 6).
 */
import type { NextRequest as NextRequestType } from 'next/server';
import { getServerSession } from 'next-auth/next';
import type { AuthResult } from '@/types/auth';
import { allRoutes, getFileRoute, getRoute, isFileOnlyField } from '@/security/core';
import { handler } from '@/security/handler';
import { fileHandler } from '@/security/fileHandler';
import { buildCallerContext, resolveAccess } from '@/security/access-resolvers';
import '@/security/registry';

const { NextRequest } = jest.requireActual<{ NextRequest: typeof NextRequestType }>('next/server');
const mockSession = getServerSession as jest.MockedFunction<typeof getServerSession>;

type Flags = { isFinance?: boolean; isBoardMember?: boolean; isSysadmin?: boolean };
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

async function callJson(endpoint: string) {
    const impl = jest.fn(async () => ({ UploadedFile: uploadedFile() }));
    const res = await handler(endpoint, impl)(new NextRequest('http://localhost/api/donations/x'), {
        params: Promise.resolve({ id: '1', disbursementId: 'D1' }),
    });
    return { status: res.status, impl, body: res.status === 200 ? await res.json() : undefined };
}

beforeEach(() => mockSession.mockReset());

describe('donation registry — shape', () => {
    it('registers 22 JSON routes (11 reads, 11 writes) and the blob file route', () => {
        expect(endpoints).toHaveLength(22);
        expect(reads).toHaveLength(11);
        expect(writes).toHaveLength(11);
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

    it.each(writes)('%s admits FINANCE and refuses BOARD', async endpoint => {
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
