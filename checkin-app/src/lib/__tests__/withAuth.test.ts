/**
 * @jest-environment node
 *
 * Direct unit test for the withAuth authorization gate (src/lib/auth.ts).
 * withAuth fronts the ~91 routes not in the security registry; its branches are
 * otherwise only hit incidentally through curated authz integration tests. Pin
 * them here by mocking the request authenticators (kiosk signature + session).
 */

import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth';
import { getServerSession } from 'next-auth/next';
import { getKioskPublicKeys, verifyKioskSignature } from '@/lib/verify-kiosk';
import { ORG_DOMAIN } from '@/lib/config';
import type { AuthenticatedUser } from '@/types/auth';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));
jest.mock('@/lib/auth-options', () => ({ authOptions: {} }));
jest.mock('@/lib/verify-kiosk', () => ({
    getKioskPublicKeys: jest.fn(),
    verifyKioskSignature: jest.fn(),
}));

const mockSession = getServerSession as jest.Mock;
const mockPubKeys = getKioskPublicKeys as jest.Mock;
const mockVerify = verifyKioskSignature as jest.Mock;

// A handler we can assert was / wasn't reached. Returns 200 so a pass is distinguishable.
// No declared params — jest.fn still records the (req, auth) the gate forwards in mock.calls.
const handler = jest.fn(async () => NextResponse.json({ ok: true }, { status: 200 }));

const sessionReq = () => new Request('http://localhost/api/whatever') as never;
const kioskReq = () =>
    new Request('http://localhost/api/whatever', {
        headers: { 'x-kiosk-signature': 'sig' },
    }) as never;

function user(overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
    return { id: 1, householdId: 10, ...overrides } as AuthenticatedUser;
}

beforeEach(() => {
    jest.clearAllMocks();
    // Default: no kiosk keys configured → kiosk signature path is inert.
    mockPubKeys.mockReturnValue([]);
    mockVerify.mockReturnValue({ ok: false });
    mockSession.mockResolvedValue(null);
});

describe('withAuth', () => {
    it('returns 401 and skips the handler for an unauthenticated request', async () => {
        const route = withAuth({}, handler);
        const res = await route(sessionReq());

        expect(res.status).toBe(401);
        expect(handler).not.toHaveBeenCalled();
    });

    it('returns 401 for a denied household, treating it as unauthenticated', async () => {
        mockSession.mockResolvedValue({ user: user({ denied: true, isSysadmin: true }) });
        // Even a route that would otherwise admit this user is locked out.
        const route = withAuth({ roles: ['isSysadmin'] }, handler);
        const res = await route(sessionReq());

        expect(res.status).toBe(401);
        expect(handler).not.toHaveBeenCalled();
    });

    // NextAuth still builds session.user from the empty token the jwt callback returns
    // when the person's re-sync lookup misses (merged away / deleted).
    it.each([
        ['an empty-token session (no id)', { name: undefined, email: undefined, image: undefined }],
        ['the dev guest persona (non-numeric id)', { id: 'guest', name: 'Logged out' }],
    ])('returns 401 for %s', async (_label, sessionUser) => {
        mockSession.mockResolvedValue({ user: sessionUser });
        const route = withAuth({}, handler);
        const res = await route(sessionReq());

        expect(res.status).toBe(401);
        expect(handler).not.toHaveBeenCalled();
    });

    it('returns 403 for a kiosk request on a route without allowKiosk', async () => {
        mockPubKeys.mockReturnValue(['key']);
        mockVerify.mockReturnValue({ ok: true });
        const route = withAuth({}, handler);
        const res = await route(kioskReq());

        expect(res.status).toBe(403);
        expect(handler).not.toHaveBeenCalled();
    });

    it('returns 403 for a session lacking all required roles', async () => {
        mockSession.mockResolvedValue({ user: user({ isSysadmin: false, isBoardMember: false }) });
        const route = withAuth({ roles: ['isSysadmin', 'isBoardMember'] }, handler);
        const res = await route(sessionReq());

        expect(res.status).toBe(403);
        expect(handler).not.toHaveBeenCalled();
    });

    it('invokes the handler for a kiosk request on an allowKiosk route', async () => {
        mockPubKeys.mockReturnValue(['key']);
        mockVerify.mockReturnValue({ ok: true });
        const route = withAuth({ allowKiosk: true }, handler);
        const res = await route(kioskReq());

        expect(res.status).toBe(200);
        expect(handler).toHaveBeenCalledTimes(1);
        // calls tuple is typed empty (handler declares no params); cast to read forwarded auth.
        expect((handler.mock.calls[0] as unknown[])[1]).toEqual({ type: 'kiosk' });
    });

    it('invokes the handler for a session holding a required role', async () => {
        mockSession.mockResolvedValue({ user: user({ isBoardMember: true }) });
        const route = withAuth({ roles: ['isSysadmin', 'isBoardMember'] }, handler);
        const res = await route(sessionReq());

        expect(res.status).toBe(200);
        expect(handler).toHaveBeenCalledTimes(1);
    });
});

/**
 * ops-stg ACCESS GATE — the API trust-boundary chokepoint (authenticateRequest, which
 * every withAuth route calls through). ops-stg runs a scrubbed copy of PRODUCTION data
 * behind PROD's Google OAuth client, deliberately unrestricted to the org workspace, so
 * ANY Google account can complete sign-in — canAccessStaging is the sysadmin-settable
 * escape hatch for an explicitly-admitted outside collaborator. This is applied
 * UNCONDITIONALLY inside authenticateRequest (not just for `withAuth` routes with a
 * `roles` list), so even a route with no role requirement at all is covered.
 */
describe('withAuth — ops-stg access gate', () => {
    const ORIGINAL_ENV = process.env.CHECKIN_ENV;
    beforeEach(() => { process.env.CHECKIN_ENV = 'stg'; });
    afterEach(() => {
        if (ORIGINAL_ENV === undefined) delete process.env.CHECKIN_ENV;
        else process.env.CHECKIN_ENV = ORIGINAL_ENV;
    });

    it('401s an anonymous request, never reaching the handler', async () => {
        const route = withAuth({}, handler);
        const res = await route(sessionReq());

        expect(res.status).toBe(401);
        expect(handler).not.toHaveBeenCalled();
    });

    it('401s an authenticated non-org session with canAccessStaging unset (false), even with no role requirement', async () => {
        mockSession.mockResolvedValue({ user: user({ hd: 'gmail.com', emailVerified: true }) });
        const route = withAuth({}, handler);
        const res = await route(sessionReq());

        expect(res.status).toBe(401);
        expect(handler).not.toHaveBeenCalled();
    });

    it('401s an org email whose emailVerified is false', async () => {
        mockSession.mockResolvedValue({ user: user({ hd: ORG_DOMAIN, emailVerified: false }) });
        const route = withAuth({}, handler);
        const res = await route(sessionReq());

        expect(res.status).toBe(401);
        expect(handler).not.toHaveBeenCalled();
    });

    it('admits an authenticated non-org session with canAccessStaging=true', async () => {
        mockSession.mockResolvedValue({ user: user({ hd: 'gmail.com', emailVerified: true, canAccessStaging: true }) });
        const route = withAuth({}, handler);
        const res = await route(sessionReq());

        expect(res.status).toBe(200);
        expect(handler).toHaveBeenCalledTimes(1);
    });

    it('admits a verified org member', async () => {
        mockSession.mockResolvedValue({ user: user({ hd: ORG_DOMAIN, emailVerified: true }) });
        const route = withAuth({}, handler);
        const res = await route(sessionReq());

        expect(res.status).toBe(200);
        expect(handler).toHaveBeenCalledTimes(1);
    });

    it('canAccessStaging alone does not satisfy a route role requirement — the gate only widens WHO gets in, not WHAT they can do', async () => {
        mockSession.mockResolvedValue({ user: user({ hd: 'gmail.com', emailVerified: true, canAccessStaging: true, isSysadmin: false }) });
        const route = withAuth({ roles: ['isSysadmin'] }, handler);
        const res = await route(sessionReq());

        expect(res.status).toBe(403);
        expect(handler).not.toHaveBeenCalled();
    });

    it('denies a kiosk request too (no org/flag claims to satisfy the predicate)', async () => {
        mockPubKeys.mockReturnValue(['key']);
        mockVerify.mockReturnValue({ ok: true });
        const route = withAuth({ allowKiosk: true }, handler);
        const res = await route(kioskReq());

        expect(res.status).toBe(401);
        expect(handler).not.toHaveBeenCalled();
    });

    it('is inert outside staging: the same non-org session that was 401d above now succeeds once CHECKIN_ENV is not stg', async () => {
        process.env.CHECKIN_ENV = 'prod';
        mockSession.mockResolvedValue({ user: user({ hd: 'gmail.com', emailVerified: true }) });
        const route = withAuth({}, handler);
        const res = await route(sessionReq());

        expect(res.status).toBe(200);
        expect(handler).toHaveBeenCalledTimes(1);
    });
});
