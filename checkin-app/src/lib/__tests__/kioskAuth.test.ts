/**
 * @jest-environment node
 *
 * Direct unit test for the withKiosk wrapper (src/lib/kioskAuth.ts) — the
 * multi-actor, signed-body sibling of withAuth. Unlike withAuth, it reads the
 * raw body and authenticates against it (the kiosk HMAC covers the body bytes),
 * so the key thing to pin is: a valid kiosk signature is admitted, an
 * unsigned/cookie-less non-local request is rejected 401, and the RAW body
 * actually reaches the verifier. authenticateRequest runs for real here; only
 * its lower primitives (kiosk verify, session, isLocal) are mocked.
 */

import { NextResponse } from 'next/server';
import { withKiosk } from '@/lib/kioskAuth';
import { getServerSession } from 'next-auth/next';
import { getKioskPublicKeys, verifyKioskSignature } from '@/lib/verify-kiosk';
import { config } from '@/lib/config';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));
jest.mock('@/lib/auth-options', () => ({ authOptions: {} }));
jest.mock('@/lib/verify-kiosk', () => ({
    getKioskPublicKeys: jest.fn(),
    verifyKioskSignature: jest.fn(),
}));
// Non-local: disables authenticateRequest's keyless local-dev kiosk fallback so
// an unsigned request must fail closed, exactly like prod/dev. isStaging is a
// jest.fn (default false, per beforeEach below) so the "ops-stg" describe below
// can flip it per-test — every OTHER case in this file runs with the gate off.
jest.mock('@/lib/config', () => ({
    config: { isLocal: () => false, isProd: () => false, isStaging: jest.fn(() => false) },
    isStagingAccessAllowed: jest.requireActual('@/lib/config').isStagingAccessAllowed,
}));

const mockSession = getServerSession as jest.Mock;
const mockPubKeys = getKioskPublicKeys as jest.Mock;
const mockVerify = verifyKioskSignature as jest.Mock;
const mockIsStaging = config.isStaging as jest.Mock;

const handler = jest.fn(async () => NextResponse.json({ ok: true }, { status: 200 }));
const route = withKiosk({ rateLimit: { name: 'kiosk-test', limit: 300 } }, handler);

const post = (init: RequestInit) =>
    route(new Request('http://localhost/api/scan', { method: 'POST', ...init }) as never);

beforeEach(() => {
    jest.clearAllMocks();
    mockPubKeys.mockReturnValue([]);
    mockVerify.mockReturnValue({ ok: false });
    mockSession.mockResolvedValue(null);
    mockIsStaging.mockReturnValue(false);
});

describe('withKiosk', () => {
    it('admits a valid kiosk signature and passes the parsed body + actor to the handler', async () => {
        mockPubKeys.mockReturnValue(['key']);
        mockVerify.mockReturnValue({ ok: true });

        const res = await post({
            headers: { 'x-kiosk-signature': 'sig' },
            body: JSON.stringify({ participantId: 5 }),
        });

        expect(res.status).toBe(200);
        expect(handler).toHaveBeenCalledTimes(1);
        const call = handler.mock.calls[0] as unknown[];
        expect(call[1]).toEqual({ participantId: 5 });   // parsed body
        expect(call[2]).toEqual({ type: 'kiosk' });        // signed actor
    });

    it('feeds the RAW request body to the kiosk verifier (HMAC covers the bytes)', async () => {
        mockPubKeys.mockReturnValue(['key']);
        mockVerify.mockReturnValue({ ok: true });
        const raw = JSON.stringify({ participantId: 7 });

        await post({ headers: { 'x-kiosk-signature': 'sig' }, body: raw });

        expect(mockVerify).toHaveBeenCalledTimes(1);
        // verifyKioskSignature(method, path, body, ts, sig, nonce, keys) — body is arg 2.
        expect((mockVerify.mock.calls[0] as unknown[])[2]).toBe(raw);
    });

    it('rejects an unsigned, cookie-less non-local request with 401 and skips the handler', async () => {
        const res = await post({ body: JSON.stringify({ participantId: 5 }) });

        expect(res.status).toBe(401);
        expect(handler).not.toHaveBeenCalled();
    });
});

// Every case above runs with the gate off (isStaging: () => false), so this is the only place the kiosk path is
// exercised WITH ops-stg active. A kiosk credential carries no org/canAccessStaging
// claim, so authenticateRequest's staging check must deny it same as any other
// non-session caller.
describe('withKiosk — ops-stg access gate', () => {
    beforeEach(() => {
        mockIsStaging.mockReturnValue(true);
    });

    it('denies an otherwise-valid kiosk signature on staging', async () => {
        mockPubKeys.mockReturnValue(['key']);
        mockVerify.mockReturnValue({ ok: true });

        const res = await post({
            headers: { 'x-kiosk-signature': 'sig' },
            body: JSON.stringify({ participantId: 5 }),
        });

        expect(res.status).toBe(401);
        expect(handler).not.toHaveBeenCalled();
    });

    it('is inert once isStaging is false again — the same valid signature is admitted', async () => {
        mockIsStaging.mockReturnValue(false);
        mockPubKeys.mockReturnValue(['key']);
        mockVerify.mockReturnValue({ ok: true });

        const res = await post({
            headers: { 'x-kiosk-signature': 'sig' },
            body: JSON.stringify({ participantId: 5 }),
        });

        expect(res.status).toBe(200);
        expect(handler).toHaveBeenCalledTimes(1);
    });
});
