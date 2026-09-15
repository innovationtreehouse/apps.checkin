/**
 * GET /api/attendance — kiosk auth with the REAL verify-kiosk module.
 *
 * The route resolves an optional session (denied-household gate) and then runs
 * its own kiosk signature verification. Session resolution must not verify the
 * kiosk signature itself: verification consumes the single-use nonce, so a
 * request verified twice fails its second check as a replay. These tests pin
 * that a kiosk poll authenticates in one pass — attendance.integration.test.ts
 * can't see this because it mocks @/lib/verify-kiosk, which has no nonce state.
 */
import crypto from 'crypto';
import { GET } from '@/app/api/attendance/route';
import { getServerSession } from 'next-auth/next';

jest.mock('next-auth/next', () => ({
    getServerSession: jest.fn(),
}));

jest.mock('@/lib/getFullAttendance', () => ({
    getFullAttendance: jest.fn().mockResolvedValue({
        attendance: [],
        counts: { total: 0 },
        safety: {},
    }),
}));

// This suite runs DB-less (it exercises signature wiring, not data); the
// route's needReview count is the one live query on the kiosk path.
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: { rawBadgeLog: { count: jest.fn().mockResolvedValue(0) } },
}));

function makeKeypair() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const rawPublicHex = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer)
        .subarray(-32)
        .toString('hex');
    // Mirrors verify-kiosk.ts — nonce is bound INTO the signed payload.
    const sign = (ts: string, nonce: string, method: string, path: string, body: string) =>
        crypto.sign(null, Buffer.from(`${ts}:${nonce}:${method}:${path}:${body}`), privateKey).toString('hex');
    return { rawPublicHex, sign };
}

// The verify module's nonce cache is module-global and persists across tests,
// so every valid-signature case must use a fresh nonce.
let nonceCounter = 0;
const freshNonce = () => `attendance-auth-nonce-${++nonceCounter}`;

function attendanceReq(headers: Record<string, string>) {
    return new Request('http://localhost/api/attendance', {
        method: 'GET',
        headers,
    }) as unknown as import('next/server').NextRequest;
}

function signedHeaders(signer: ReturnType<typeof makeKeypair>, nonce: string) {
    const ts = String(Math.floor(Date.now() / 1000));
    return {
        'x-kiosk-timestamp': ts,
        'x-kiosk-nonce': nonce,
        'x-kiosk-signature': signer.sign(ts, nonce, 'GET', '/api/attendance', ''),
    };
}

describe('GET /api/attendance — real kiosk signature wiring', () => {
    const ORIG_KEY = process.env.KIOSK_PUBLIC_KEY;
    let signer: ReturnType<typeof makeKeypair>;

    beforeEach(() => {
        (getServerSession as jest.Mock).mockResolvedValue(null);
        signer = makeKeypair();
        process.env.KIOSK_PUBLIC_KEY = signer.rawPublicHex;
    });

    afterAll(() => {
        if (ORIG_KEY === undefined) delete process.env.KIOSK_PUBLIC_KEY;
        else process.env.KIOSK_PUBLIC_KEY = ORIG_KEY;
    });

    it('a signed kiosk poll authenticates in a single pass (nonce not consumed twice)', async () => {
        const res = await GET(attendanceReq(signedHeaders(signer, freshNonce())));
        const json = await res.json();
        expect(res.status).toBe(200);
        expect(json.signedRequest).toBe(true);
        expect(json.access).toBe('full');
    });

    it('an actual replay (same nonce sent twice) is still rejected', async () => {
        const headers = signedHeaders(signer, freshNonce());
        const first = await GET(attendanceReq(headers));
        expect(first.status).toBe(200);

        const second = await GET(attendanceReq(headers));
        const json = await second.json();
        expect(second.status).toBe(401);
        expect(json.error).toBe('Replay detected');
    });

    it('kiosk headers with a bad signature are rejected', async () => {
        const headers = signedHeaders(signer, freshNonce());
        headers['x-kiosk-signature'] = '00'.repeat(64);
        const res = await GET(attendanceReq(headers));
        expect(res.status).toBe(401);
    });

    it('a signed kiosk poll stays display-only even when a keyholder session is present', async () => {
        const { getFullAttendance } = jest.requireMock('@/lib/getFullAttendance') as {
            getFullAttendance: jest.Mock;
        };
        (getServerSession as jest.Mock).mockResolvedValue({
            user: { id: 1, isKeyholder: true, isSysadmin: false, isBoardMember: false },
        });

        const res = await GET(attendanceReq(signedHeaders(signer, freshNonce())));
        const json = await res.json();
        expect(res.status).toBe(200);
        expect(json.signedRequest).toBe(true);
        expect(getFullAttendance).toHaveBeenCalledWith({ kiosk: true });
    });
});
