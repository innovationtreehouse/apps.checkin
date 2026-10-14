/**
 * @jest-environment node
 */
/**
 * Unit tests for the /api request body size check in the site middleware, and that /api gets
 * nothing else from it (no login or access gate).
 */

import type { NextRequest } from 'next/server';
import { getToken } from 'next-auth/jwt';
import {
    MAX_JSON_BODY_BYTES,
    MAX_UPLOAD_BODY_BYTES,
    UPLOAD_ROUTES,
} from '@/lib/requestBodyLimit';

jest.mock('next-auth/jwt', () => ({ getToken: jest.fn() }));

// next/jest's next/server shim has no callable NextResponse statics; stub the ones used.
jest.mock('next/server', () => ({
    NextResponse: {
        json: (body: unknown, init: { status: number }) => ({ kind: 'json', status: init.status, body }),
        redirect: (url: URL) => ({ kind: 'redirect', location: url.toString() }),
        next: () => ({ kind: 'next' }),
    },
}));

// Imported after the mocks so the middleware binds to the stubbed NextResponse.
import { middleware } from '@/middleware';

type Result = { kind: string; status?: number };

const apiReq = (pathname: string, contentLength: number | string | null): NextRequest => ({
    nextUrl: { pathname, search: '' },
    url: `http://localhost:4000${pathname}`,
    headers: new Headers(contentLength === null ? {} : { 'content-length': String(contentLength) }),
} as unknown as NextRequest);

const run = async (pathname: string, contentLength: number | string | null) =>
    (await middleware(apiReq(pathname, contentLength))) as unknown as Result;

describe('middleware /api body size limit', () => {
    it('passes a JSON body at the limit', async () => {
        expect((await run('/api/scan', MAX_JSON_BODY_BYTES)).kind).toBe('next');
    });

    it('answers 413 for a JSON body over the limit', async () => {
        const res = await run('/api/scan', MAX_JSON_BODY_BYTES + 1);
        expect(res.kind).toBe('json');
        expect(res.status).toBe(413);
    });

    it('allows the upload limit on every upload route, and no more', async () => {
        for (const route of UPLOAD_ROUTES) {
            expect((await run(route, MAX_UPLOAD_BODY_BYTES)).kind).toBe('next');
            expect((await run(route, MAX_UPLOAD_BODY_BYTES + 1)).status).toBe(413);
        }
    });

    it('does not extend the upload limit to sub-paths of an upload route', async () => {
        expect((await run(`${UPLOAD_ROUTES[0]}/123/blob`, MAX_JSON_BODY_BYTES + 1)).status).toBe(413);
    });

    it('passes a request with no Content-Length (the proxy body limit bounds it)', async () => {
        expect((await run('/api/webhooks/shopify', null)).kind).toBe('next');
    });
});

describe('middleware leaves /api otherwise untouched', () => {
    const ORIGINAL_ENV = process.env.CHECKIN_ENV;
    afterEach(() => {
        if (ORIGINAL_ENV === undefined) delete process.env.CHECKIN_ENV;
        else process.env.CHECKIN_ENV = ORIGINAL_ENV;
    });

    it.each(['dev', 'stg', 'prod'])('does not apply the login or access gate in %s', async (env) => {
        process.env.CHECKIN_ENV = env;
        (getToken as jest.Mock).mockClear().mockResolvedValue({ denied: true });

        const res = await run('/api/scan', 100);

        expect(res.kind).toBe('next');
        expect(getToken).not.toHaveBeenCalled();
    });
});
