/**
 * @jest-environment node
 *
 * The file-route primitive (plan rule 7, harness H6): defineFileRoute
 * validation, fileHandler's authenticate → authorize → per-row scope →
 * delivery-header flow, and the guarantee that no JSON route (handler())
 * ever returns a field a file route serves.
 *
 * The fixture file route serves `Person.email` — a real classified `pii`
 * field with a `their_own` binding — so the JSON-route sweep below runs
 * against every registered route that grants Person pii, which is many.
 */
import type { NextRequest as NextRequestType } from 'next/server';
import type { AuthResult } from '@/types/auth';
import {
    allFileRoutes,
    allRoutes,
    classifications,
    defineFileRoute,
    defineRoute,
    getFileRoute,
    isFileOnlyField,
    type FileRouteSpec,
    type Token,
} from '@/security/core';
import { stripValue } from '@/security/stripper';
import { ROW_SCOPE_KEY } from '@/security/scopeBindings';
import type { CallerContext } from '@/security/access-resolvers';
import { fileHandler, type FileResult } from '@/security/fileHandler';
import { notFound } from '@/security/handler';
import { authenticateRequest } from '@/lib/auth';

jest.mock('@/lib/auth', () => ({ authenticateRequest: jest.fn() }));
// jest.setup.js stubs next/server down to NextResponse.json; the request class is the real one.
const { NextRequest } = jest.requireActual<{ NextRequest: typeof NextRequestType }>('next/server');
const mockAuth = authenticateRequest as jest.MockedFunction<typeof authenticateRequest>;

const ENDPOINT = 'GET /api/__test__/file/[id]';
defineFileRoute({
    endpoint: ENDPOINT,
    authorize: 'authenticated',
    orderedView: [['authenticated', ['their_own:pii']]],
    file: { model: 'Person', field: 'email' },
});

function session(id: unknown): AuthResult {
    return {
        type: 'session',
        user: {
            id,
            isSysadmin: false,
            isBoardMember: false,
            isKeyholder: false,
            isBackgroundCheckReviewer: false,
            isOperations: false,
        },
    } as AuthResult;
}

const BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46]);

function call(impl: () => Promise<FileResult>) {
    const route = fileHandler(ENDPOINT, impl);
    return route(new NextRequest('http://localhost/api/__test__/file/7'), {
        params: Promise.resolve({ id: '7' }),
    });
}

const ownRow = (contentType: FileResult['contentType'], filename?: string): FileResult => ({
    row: { id: 7, email: BYTES },
    contentType,
    filename,
});

beforeEach(() => mockAuth.mockReset());

describe('fileHandler — admission', () => {
    it('401s an unauthenticated caller without running the impl', async () => {
        mockAuth.mockResolvedValue({ type: 'unauthenticated' });
        const impl = jest.fn();
        const res = await call(impl);
        expect(res.status).toBe(401);
        expect(impl).not.toHaveBeenCalled();
    });

    it('401s a kiosk caller — a file route has no kiosk view', async () => {
        mockAuth.mockResolvedValue({ type: 'kiosk' });
        const impl = jest.fn();
        expect((await call(impl)).status).toBe(401);
        expect(impl).not.toHaveBeenCalled();
    });

    it.each([undefined, null, '7', 7.5, NaN])(
        '401s an id-less session (id = %p) — plan rule 6',
        async id => {
            mockAuth.mockResolvedValue(session(id));
            const impl = jest.fn();
            expect((await call(impl)).status).toBe(401);
            expect(impl).not.toHaveBeenCalled();
        },
    );

    it('403s a session the authorize gate rejects', async () => {
        defineFileRoute({
            endpoint: 'GET /api/__test__/board-file',
            authorize: { anyRole: ['isBoardMember'] },
            orderedView: [['isBoardMember', ['everyones:pii']]],
            file: { model: 'Person', field: 'email' },
        });
        mockAuth.mockResolvedValue(session(7));
        const impl = jest.fn();
        const res = await fileHandler('GET /api/__test__/board-file', impl)(
            new NextRequest('http://localhost/api/__test__/board-file'),
        );
        expect(res.status).toBe(403);
        expect(impl).not.toHaveBeenCalled();
    });

    it('500s an endpoint with no file-route registration', async () => {
        jest.spyOn(console, 'error').mockImplementationOnce(() => {});
        mockAuth.mockResolvedValue(session(7));
        const res = await fileHandler('GET /api/__test__/unregistered', jest.fn())(
            new NextRequest('http://localhost/x'),
        );
        expect(res.status).toBe(500);
    });
});

describe('fileHandler — per-row scope', () => {
    it("404s a row the caller's view does not cover (another person's file)", async () => {
        mockAuth.mockResolvedValue(session(8));
        const res = await call(async () => ownRow('image/png'));
        expect(res.status).toBe(404);
        expect(res.headers.get('Content-Type')).not.toBe('image/png');
    });

    it('maps an ApiResponseError from the impl to its status', async () => {
        mockAuth.mockResolvedValue(session(7));
        const res = await call(async () => {
            throw notFound();
        });
        expect(res.status).toBe(404);
    });

    it('500s (opaque) when the served field is not bytes', async () => {
        jest.spyOn(console, 'error').mockImplementationOnce(() => {});
        mockAuth.mockResolvedValue(session(7));
        const res = await call(async () => ({ row: { id: 7, email: 'a@b.c' }, contentType: 'image/png' }));
        expect(res.status).toBe(500);
    });

    it('500s a content type outside the owner-approved allowlist', async () => {
        jest.spyOn(console, 'error').mockImplementationOnce(() => {});
        mockAuth.mockResolvedValue(session(7));
        const res = await call(async () => ({
            row: { id: 7, email: BYTES },
            contentType: 'text/html' as FileResult['contentType'],
        }));
        expect(res.status).toBe(500);
    });
});

describe('fileHandler — delivery headers', () => {
    async function served(contentType: FileResult['contentType'], filename?: string) {
        mockAuth.mockResolvedValue(session(7));
        const res = await call(async () => ownRow(contentType, filename));
        expect(res.status).toBe(200);
        expect(new Uint8Array(await res.arrayBuffer())).toEqual(BYTES);
        expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
        expect(res.headers.get('Cache-Control')).toBe('private, no-store');
        expect(res.headers.get('Content-Length')).toBe(String(BYTES.byteLength));
        return res.headers;
    }

    it.each(['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const)(
        '%s displays inline under a CSP sandbox',
        async type => {
            const h = await served(type);
            expect(h.get('Content-Type')).toBe(type);
            expect(h.get('Content-Disposition')).toBe('inline');
            expect(h.get('Content-Security-Policy')).toBe('sandbox');
        },
    );

    it('a PDF displays inline WITHOUT a sandbox (Chrome refuses sandboxed PDFs)', async () => {
        const h = await served('application/pdf');
        expect(h.get('Content-Type')).toBe('application/pdf');
        expect(h.get('Content-Disposition')).toBe('inline');
        expect(h.get('Content-Security-Policy')).toBeNull();
    });

    it('text/plain is only ever an attachment', async () => {
        const h = await served('text/plain');
        expect(h.get('Content-Type')).toBe('text/plain; charset=utf-8');
        expect(h.get('Content-Disposition')).toBe('attachment');
    });

    it('a filename is quoted ASCII plus an RFC 5987 form, never raw header text', async () => {
        const h = await served('text/plain', 'café "x"\r\nSet-Cookie: a=b.txt');
        const cd = h.get('Content-Disposition') ?? '';
        expect(cd).not.toMatch(/[\r\n]/);
        expect(cd).toBe(
            'attachment; filename="caf_ _x___Set-Cookie_ a_b.txt"; ' +
                "filename*=UTF-8''caf%C3%A9%20%22x%22%0D%0ASet-Cookie%3A%20a%3Db.txt",
        );
    });
});

describe('defineFileRoute — registration', () => {
    const base: FileRouteSpec = {
        endpoint: 'GET /api/__test__/reg',
        authorize: 'authenticated',
        orderedView: [['authenticated', ['their_own:pii']]],
        file: { model: 'Person', field: 'phone' },
    };

    it('registers as a file route, not a JSON route', () => {
        expect(getFileRoute(ENDPOINT)?.file).toEqual({ model: 'Person', field: 'email' });
        expect([...allRoutes()].map(([e]) => e)).not.toContain(ENDPOINT);
    });

    it('rejects a non-GET endpoint', () => {
        expect(() => defineFileRoute({ ...base, endpoint: 'POST /api/__test__/reg' })).toThrow(/GET/);
    });

    it.each(['public', 'kiosk'] as const)('rejects authorize %p', authorize => {
        expect(() =>
            defineFileRoute({ ...base, authorize } as unknown as FileRouteSpec),
        ).toThrow(/authorize/);
    });

    it('rejects an unknown model or field', () => {
        expect(() =>
            defineFileRoute({ ...base, file: { model: 'Person', field: 'nope' } }),
        ).toThrow(/unknown field/);
        expect(() =>
            defineFileRoute({ ...base, file: { model: 'Nope' as 'Person', field: 'x' } }),
        ).toThrow(/unknown field/);
    });

    it('rejects a secret-tier field — secret never leaves', () => {
        const secret = Object.entries(classifications).flatMap(([model, fields]) =>
            Object.entries(fields as Record<string, string>)
                .filter(([, tier]) => tier === 'secret')
                .map(([field]) => ({ model, field })),
        )[0];
        expect(secret).toBeDefined();
        expect(() =>
            defineFileRoute({ ...base, file: secret as FileRouteSpec['file'] }),
        ).toThrow(/secret/);
    });

    it('rejects an invalid view token, like defineRoute', () => {
        expect(() =>
            defineFileRoute({ ...base, orderedView: [['authenticated', ['bogus' as Token]]] }),
        ).toThrow(/invalid token/);
    });

    it('shares one endpoint namespace with JSON routes', () => {
        expect(() =>
            defineRoute({ endpoint: ENDPOINT, authorize: 'authenticated', envelope: null, orderedView: [] }),
        ).toThrow(/Duplicate/);
        expect(() => defineFileRoute({ ...base, endpoint: ENDPOINT })).toThrow(/Duplicate/);
    });
});

describe('no JSON route returns a file-only field', () => {
    const SCOPES = [
        'everyones', 'their_own', 'their_households', 'led_households',
        'their_program_participants', 'their_program_households', 'keyholders',
        'all_current_visitors',
    ];
    const EVERY_TOKEN = [
        'public', 'member',
        ...SCOPES.flatMap(s => ['pii', 'personal', 'internal'].map(t => `${s}:${t}`)),
    ] as Token[];

    // A context in which the caller holds every scope the bindings can derive
    // for a row with id/householdId/personId = 1.
    const ctx: CallerContext = {
        selfId: 1,
        householdId: 1,
        isKeyholder: true,
        isKiosk: false,
        programsLed: new Set([1]),
        programsCoreVolIn: new Set([1]),
        participantIdsInScopePrograms: new Set([1]),
        householdIdsInScopePrograms: new Set([1]),
        eventIdsInScopePrograms: new Set([1]),
        activeVisitorIds: new Set([1]),
        ledHouseholdMemberIds: new Set([1]),
    };

    function fullRow(model: string): Record<string, unknown> {
        const tiers = classifications[model as keyof typeof classifications] as Record<string, string>;
        const row: Record<string, unknown> = {};
        for (const field of Object.keys(tiers)) row[field] = 1;
        const scopeKey = ROW_SCOPE_KEY[model];
        if (scopeKey) row[scopeKey] = 1;
        return row;
    }

    const fileFields = [...allFileRoutes()].map(([, spec]) => spec.file);

    it('the fixture makes this sweep non-vacuous', () => {
        expect(fileFields).toContainEqual({ model: 'Person', field: 'email' });
        expect(isFileOnlyField('Person', 'email')).toBe(true);
        expect(isFileOnlyField('Person', 'phone')).toBe(false);
        // The maximal view does deliver Person's other pii, so the sweep can see a leak.
        expect(stripValue('Person', fullRow('Person'), EVERY_TOKEN, ctx)).toHaveProperty('phone');
    });

    it('is stripped under every view of every registered JSON route, and under a maximal view', () => {
        const views = [...allRoutes()].flatMap(([endpoint, spec]) =>
            spec.orderedView.map(([role, tokens]) => ({ label: `${endpoint} as ${role}`, tokens })),
        );
        views.push({ label: 'maximal view', tokens: EVERY_TOKEN });
        expect(views.length).toBeGreaterThan(1);

        const leaks: string[] = [];
        for (const { model, field } of fileFields) {
            for (const { label, tokens } of views) {
                const out = stripValue(model, fullRow(model), tokens, ctx) as Record<string, unknown>;
                if (field in out) leaks.push(`${label} returns ${model}.${field}`);
            }
        }
        expect(leaks).toEqual([]);
    });
});
