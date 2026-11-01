/**
 * @jest-environment node
 */
/**
 * Unit tests for the household-denial gate in the site middleware.
 * getToken is mocked so we drive the gate purely off token.denied.
 */

import type { NextRequest } from 'next/server';
import { getToken } from 'next-auth/jwt';
import { ORG_DOMAIN } from '@/lib/config';

jest.mock('next-auth/jwt', () => ({ getToken: jest.fn() }));

// next/jest shims next/server and its NextResponse statics aren't callable under jest.
// Replace them with a minimal functional stub so we can assert which branch the
// middleware takes (redirect target vs. pass-through) without the real edge runtime.
type SetCookie = { name: string; value: string; options: Record<string, unknown> };

jest.mock('next/server', () => ({
    NextResponse: {
        redirect: (url: URL) => {
            const setCookies: SetCookie[] = [];
            return {
                kind: 'redirect',
                location: url.toString(),
                setCookies,
                cookies: {
                    set: (name: string, value: string, options: Record<string, unknown>) => {
                        setCookies.push({ name, value, options });
                    },
                },
            };
        },
        next: () => ({ kind: 'next', location: null }),
    },
}));

// Imported after the mocks so the middleware binds to the stubbed NextResponse.
import { middleware, config as middlewareConfig } from '@/middleware';

// Every signed-in token names a subject, so the mock supplies one unless the test overrides it.
const mockToken = (token: Record<string, unknown> | null) =>
    (getToken as jest.Mock).mockResolvedValue(token && { sub: '1', ...token });

// The middleware only touches nextUrl.pathname, nextUrl.search, url, and cookies.
const reqFor = (pathname: string, search = '', cookieNames: string[] = []): NextRequest => ({
    nextUrl: { pathname, search },
    url: `http://localhost:4000${pathname}${search}`,
    cookies: { getAll: () => cookieNames.map((name) => ({ name, value: 'x' })) },
} as unknown as NextRequest);

describe('middleware household-denial gate', () => {
    it('redirects a denied session to /access-denied', async () => {
        mockToken({ denied: true });

        const res = await middleware(reqFor('/membership-ops/households')) as unknown as { kind: string; location: string };

        expect(res.kind).toBe('redirect');
        expect(res.location).toBe('http://localhost:4000/access-denied');
    });

    it('does not loop — a denied session already on /access-denied is let through', async () => {
        mockToken({ denied: true });

        const res = await middleware(reqFor('/access-denied')) as unknown as { kind: string };

        expect(res.kind).toBe('next');
    });

    it('does not send a non-denied session to /access-denied', async () => {
        mockToken({ denied: false, hd: 'example.org', emailVerified: true });

        const res = await middleware(reqFor('/membership-ops/households')) as unknown as { location: string | null };

        expect(res.location).not.toBe('http://localhost:4000/access-denied');
    });
});

/**
 * The jwt callback empties the token of a person merged away or deleted, but getToken()
 * decodes the cookie without running it, so the middleware is what keeps page navigation
 * off a signed-in shell whose every API call answers 401.
 */
describe('middleware emptied-session gate', () => {
    // prod, where the dev org gate can't confound these: the emptied-session gate runs in every env.
    const ORIGINAL_ENV = process.env.CHECKIN_ENV;
    beforeEach(() => { process.env.CHECKIN_ENV = 'prod'; });
    afterEach(() => { process.env.CHECKIN_ENV = ORIGINAL_ENV; });

    type Res = { kind: string; location: string | null; setCookies?: SetCookie[] };

    // What NextAuth encodes when the jwt callback returns `{}`: only its own claims.
    const emptiedToken = { iat: 1, exp: 2, jti: 'j' };

    it('redirects an emptied token to /signin and expires the session cookie', async () => {
        (getToken as jest.Mock).mockResolvedValue(emptiedToken);

        const res = await middleware(reqFor(
            '/events', '?tab=roster',
            ['__Secure-next-auth.session-token.0', '__Secure-next-auth.session-token.1', 'other'],
        )) as unknown as Res;

        expect(res.kind).toBe('redirect');
        expect(res.location).toBe('http://localhost:4000/signin?callbackUrl=%2Fevents%3Ftab%3Droster');
        expect(res.setCookies).toEqual([
            { name: '__Secure-next-auth.session-token.0', value: '', options: { path: '/', maxAge: 0, secure: true } },
            { name: '__Secure-next-auth.session-token.1', value: '', options: { path: '/', maxAge: 0, secure: true } },
        ]);
    });

    it('expires an unprefixed session cookie without the secure flag', async () => {
        (getToken as jest.Mock).mockResolvedValue(emptiedToken);

        const res = await middleware(reqFor('/events', '', ['next-auth.session-token'])) as unknown as Res;

        expect(res.setCookies).toEqual([
            { name: 'next-auth.session-token', value: '', options: { path: '/', maxAge: 0, secure: false } },
        ]);
    });

    it('lets a normal signed-in token through', async () => {
        mockToken({ sub: '42', id: 42 });

        const res = await middleware(reqFor('/events')) as unknown as Res;

        expect(res.kind).toBe('next');
    });

    it('lets the dev logged-out guest persona through, though it carries no person id', async () => {
        mockToken({ sub: 'guest', impersonatedBy: 'real@example.org' });

        const res = await middleware(reqFor('/events')) as unknown as Res;

        expect(res.kind).toBe('next');
    });

    it('lets the guest persona through the dev org gate with the claims a dev mint stamps', async () => {
        process.env.CHECKIN_ENV = 'dev';
        mockToken({ sub: 'guest', impersonatedBy: 'real@example.org', hd: ORG_DOMAIN, emailVerified: true });

        const res = await middleware(reqFor('/events')) as unknown as Res;

        expect(res.kind).toBe('next');
    });
});

/**
 * Dev-instance org-login gate (CHECKIN_ENV=dev). This is the "not world-readable" fence
 * for the public cloud dev instance: every page requires a verified org member, else /signin.
 * A fault here silently exposes every page to anonymous visitors.
 */
describe('middleware dev-instance org gate', () => {
    const ORIGINAL_ENV = process.env.CHECKIN_ENV;
    beforeEach(() => { process.env.CHECKIN_ENV = 'dev'; });
    afterEach(() => { process.env.CHECKIN_ENV = ORIGINAL_ENV; });

    type Res = { kind: string; location: string | null };

    it('lets a verified org member through', async () => {
        mockToken({ hd: ORG_DOMAIN, emailVerified: true });

        const res = await middleware(reqFor('/membership-ops/households')) as unknown as Res;

        expect(res.kind).toBe('next');
        expect(res.location).toBeNull();
    });

    it('redirects a non-org email to /signin', async () => {
        mockToken({ hd: 'gmail.com', emailVerified: true });

        const res = await middleware(reqFor('/membership-ops/households')) as unknown as Res;

        expect(res.kind).toBe('redirect');
        expect(res.location).toBe('http://localhost:4000/signin?callbackUrl=%2Fmembership-ops%2Fhouseholds');
    });

    it('redirects an unverified org email to /signin', async () => {
        mockToken({ hd: ORG_DOMAIN, emailVerified: false });

        const res = await middleware(reqFor('/membership-ops/households')) as unknown as Res;

        expect(res.kind).toBe('redirect');
        expect(res.location).toBe('http://localhost:4000/signin?callbackUrl=%2Fmembership-ops%2Fhouseholds');
    });

    it('redirects an anonymous visitor to /signin, preserving callbackUrl with query', async () => {
        mockToken(null);

        const res = await middleware(reqFor('/events', '?tab=roster')) as unknown as Res;

        expect(res.kind).toBe('redirect');
        expect(res.location).toBe('http://localhost:4000/signin?callbackUrl=%2Fevents%3Ftab%3Droster');
    });
});

/**
 * In prod (and unset, which fails safe to prod) the gate is inert — the org check must NOT
 * apply, or public surfaces break. This guards against the gate leaking out of dev.
 */
describe('middleware org gate is inert outside dev', () => {
    const ORIGINAL_ENV = process.env.CHECKIN_ENV;
    beforeEach(() => { process.env.CHECKIN_ENV = 'prod'; });
    afterEach(() => { process.env.CHECKIN_ENV = ORIGINAL_ENV; });

    it('lets a non-org anonymous visitor through in prod', async () => {
        mockToken(null);

        const res = await middleware(reqFor('/membership-ops/households')) as unknown as { kind: string };

        expect(res.kind).toBe('next');
    });
});

/**
 * ops-stg ACCESS GATE (pages surface). ops-stg runs a scrubbed copy of PRODUCTION data
 * behind PROD's Google OAuth client, deliberately unrestricted to the org workspace, so
 * ANY Google account can complete sign-in — canAccessStaging is the sysadmin-settable
 * escape hatch for an explicitly-admitted outside collaborator. Unlike the dev-instance
 * gate above, an AUTHENTICATED caller who fails the predicate is bounced to the bare
 * /access-denied page, not /signin — re-prompting login would only loop a stranger
 * through Google to the same wall. An ANONYMOUS caller does go to /signin, like the dev
 * gate: /access-denied deliberately carries no sign-in affordance (it is also the
 * DENIED-household screen), so an org member who hasn't logged in yet would dead-end.
 * This is only ONE of three surfaces the gate covers — see authenticateRequest
 * (lib/auth.ts) and resolveAccess (security/access-resolvers.ts) for the API surfaces,
 * which this middleware's matcher can never reach (see the matcher describe below).
 */
describe('middleware ops-stg access gate', () => {
    // CHECKIN_ENV=stg is the sole staging signal; it also collapses checkinEnv() to
    // 'prod', so the dev gate below can't confound these staging assertions.
    const ORIGINAL_ENV = process.env.CHECKIN_ENV;
    beforeEach(() => { process.env.CHECKIN_ENV = 'stg'; });
    afterEach(() => {
        if (ORIGINAL_ENV === undefined) delete process.env.CHECKIN_ENV;
        else process.env.CHECKIN_ENV = ORIGINAL_ENV;
    });

    type Res = { kind: string; location: string | null };

    it('sends an ANONYMOUS visitor to /signin with a callbackUrl (never next()) — /access-denied has no sign-in affordance', async () => {
        mockToken(null);

        const res = await middleware(reqFor('/membership-ops/households')) as unknown as Res;

        expect(res.kind).toBe('redirect');
        expect(res.location).toBe(
            'http://localhost:4000/signin?callbackUrl=%2Fmembership-ops%2Fhouseholds',
        );
    });

    it('does not loop: the caller returning from sign-in still fails the predicate and lands on /access-denied', async () => {
        // The stranger case the /signin redirect above must not turn into a cycle —
        // any Google account can complete sign-in on ops-stg, so the caller comes back
        // WITH a token, which takes the authenticated branch instead of /signin again.
        mockToken({ hd: 'gmail.com', emailVerified: true });

        const res = await middleware(reqFor('/membership-ops/households')) as unknown as Res;

        expect(res.kind).toBe('redirect');
        expect(res.location).toBe('http://localhost:4000/access-denied');
    });

    it('still sends a DENIED household to /access-denied, not /signin, even with no staging access', async () => {
        // The denial gate runs before the staging block, so a denied session must not
        // be offered a login round-trip by the anonymous branch.
        mockToken({ denied: true });

        const res = await middleware(reqFor('/membership-ops/households')) as unknown as Res;

        expect(res.kind).toBe('redirect');
        expect(res.location).toBe('http://localhost:4000/access-denied');
    });

    it('lets a verified org member through', async () => {
        mockToken({ hd: ORG_DOMAIN, emailVerified: true });

        const res = await middleware(reqFor('/membership-ops/households')) as unknown as Res;

        expect(res.kind).toBe('next');
    });

    it('redirects an authenticated non-org caller with canAccessStaging unset (false) to /access-denied', async () => {
        mockToken({ hd: 'gmail.com', emailVerified: true, canAccessStaging: false });

        const res = await middleware(reqFor('/membership-ops/households')) as unknown as Res;

        expect(res.kind).toBe('redirect');
        expect(res.location).toBe('http://localhost:4000/access-denied');
    });

    it('lets an authenticated non-org caller through when canAccessStaging is true', async () => {
        mockToken({ hd: 'gmail.com', emailVerified: true, canAccessStaging: true });

        const res = await middleware(reqFor('/membership-ops/households')) as unknown as Res;

        expect(res.kind).toBe('next');
    });

    it('redirects an org email whose emailVerified is false, even with canAccessStaging unset', async () => {
        mockToken({ hd: ORG_DOMAIN, emailVerified: false });

        const res = await middleware(reqFor('/membership-ops/households')) as unknown as Res;

        expect(res.kind).toBe('redirect');
        expect(res.location).toBe('http://localhost:4000/access-denied');
    });

    it('does not loop — a caller already on /access-denied is let through', async () => {
        mockToken(null);

        const res = await middleware(reqFor('/access-denied')) as unknown as Res;

        expect(res.kind).toBe('next');
    });

    it('a DENIED household is redirected to /access-denied even with canAccessStaging true (the household gate runs first)', async () => {
        mockToken({ denied: true, canAccessStaging: true });

        const res = await middleware(reqFor('/membership-ops/households')) as unknown as Res;

        expect(res.kind).toBe('redirect');
        expect(res.location).toBe('http://localhost:4000/access-denied');
    });
});

/**
 * The staging gate keys off CHECKIN_ENV=stg — it must stay inert for every other
 * CHECKIN_ENV (prod/dev/local), or those deploys would suddenly start enforcing the
 * staging predicate. (The dev-instance gate is covered separately above.)
 */
describe('middleware ops-stg gate is inert outside staging', () => {
    const ORIGINAL_ENV = process.env.CHECKIN_ENV;
    // Pin CHECKIN_ENV=prod: not 'stg' (staging gate off) and not 'dev' (so the dev
    // gate — covered above — doesn't fire and confound this).
    beforeEach(() => { process.env.CHECKIN_ENV = 'prod'; });
    afterEach(() => {
        if (ORIGINAL_ENV === undefined) delete process.env.CHECKIN_ENV;
        else process.env.CHECKIN_ENV = ORIGINAL_ENV;
    });

    it('lets a non-org anonymous visitor through in prod (CHECKIN_ENV is not stg)', async () => {
        mockToken(null);

        const res = await middleware(reqFor('/membership-ops/households')) as unknown as { kind: string };

        expect(res.kind).toBe('next');
    });
});

/**
 * The page pattern — not the function body — is what keeps the gate off /api. Next applies the
 * matcher before invoking middleware(), so assert the regexes themselves: the page pattern
 * excludes API/signin/static and includes real page routes; the /api pattern covers all of /api.
 */
describe('middleware matcher', () => {
    const [pagePattern, apiPattern] = middlewareConfig.matcher as string[];
    const matchesPage = (path: string) => new RegExp(`^${pagePattern}$`).test(path);
    const matches = (path: string) =>
        (middlewareConfig.matcher as string[]).some((p) => new RegExp(`^${p}$`).test(path));

    it('keeps /api out of the page pattern (routes self-enforce auth; never redirect JSON to /signin)', () => {
        expect(matchesPage('/api/scan')).toBe(false);
        expect(matchesPage('/api/auth/callback/google')).toBe(false);
    });

    it('matches every /api route with the /api pattern', () => {
        expect(new RegExp(`^${apiPattern}$`).test('/api/scan')).toBe(true);
        expect(new RegExp(`^${apiPattern}$`).test('/api/donations/uploaded-files')).toBe(true);
    });

    it('exempts signin and framework/static paths', () => {
        expect(matches('/signin')).toBe(false);
        expect(matches('/_next/static/chunk.js')).toBe(false);
        expect(matches('/favicon.ico')).toBe(false);
        expect(matches('/brand/logo.webp')).toBe(false);
    });

    it('gates real page routes', () => {
        expect(matches('/membership-ops/households')).toBe(true);
        expect(matches('/events')).toBe(true);
    });
});
