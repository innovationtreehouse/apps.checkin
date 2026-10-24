/**
 * @jest-environment node
 *
 * GET /api/system-status/kiosk-version — the kiosk's ping.
 *
 * The kiosk polls this once a second, so the route must answer entirely from
 * this task's memory: it reads the attendance cache without computing, and
 * never calls getFullAttendance (which would query and wake a paused Aurora).
 * The building state rides on a verified signature only — "the building is
 * empty right now" is not public.
 */
import crypto from 'crypto';
import { GET } from '../route';
import { SCAN_PROTOCOL_VERSION } from '@/lib/scanProtocol';
import { getFullAttendance, peekFacilityState } from '@/lib/getFullAttendance';

jest.mock('@/lib/getFullAttendance', () => ({
    getFullAttendance: jest.fn(),
    peekFacilityState: jest.fn(() => ({ open: true, rosterGeneration: 7 })),
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

// The verify module's nonce cache is module-global and persists across tests.
let nonceCounter = 0;
const freshNonce = () => `kiosk-version-nonce-${++nonceCounter}`;

const PATH = '/api/system-status/kiosk-version';

function pingReq(headers: Record<string, string> = {}) {
    return new Request('http://localhost' + PATH, { method: 'GET', headers }) as unknown as
        import('next/server').NextRequest;
}

describe('GET /api/system-status/kiosk-version', () => {
    const realKey = process.env.KIOSK_PUBLIC_KEY;

    afterEach(() => {
        if (realKey === undefined) delete process.env.KIOSK_PUBLIC_KEY;
        else process.env.KIOSK_PUBLIC_KEY = realKey;
        jest.clearAllMocks();
    });

    it('advertises the deploy version and the scan protocol generation', async () => {
        const res = await GET(pingReq());
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(typeof body.version).toBe('string');
        expect(body.version.length).toBeGreaterThan(0);
        // The contract bit older kiosk builds gate replay behavior on.
        expect(body.scanProtocolVersion).toBe(SCAN_PROTOCOL_VERSION);
    });

    it('tells an unsigned caller nothing about the building', async () => {
        const { rawPublicHex } = makeKeypair();
        process.env.KIOSK_PUBLIC_KEY = rawPublicHex;

        const body = await (await GET(pingReq())).json();

        expect(body.facility).toBeUndefined();
        expect(peekFacilityState).not.toHaveBeenCalled();
    });

    it('gives a verified kiosk the state this task already holds', async () => {
        const { rawPublicHex, sign } = makeKeypair();
        process.env.KIOSK_PUBLIC_KEY = rawPublicHex;
        const ts = String(Math.floor(Date.now() / 1000));
        const nonce = freshNonce();

        const body = await (await GET(pingReq({
            'x-kiosk-timestamp': ts,
            'x-kiosk-nonce': nonce,
            'x-kiosk-signature': sign(ts, nonce, 'GET', PATH, ''),
        }))).json();

        expect(body.facility).toEqual({ open: true, rosterGeneration: 7 });
    });

    it('serves the ping without ever reading the roster from the database', async () => {
        const { rawPublicHex, sign } = makeKeypair();
        process.env.KIOSK_PUBLIC_KEY = rawPublicHex;
        const ts = String(Math.floor(Date.now() / 1000));
        const nonce = freshNonce();

        await GET(pingReq({
            'x-kiosk-timestamp': ts,
            'x-kiosk-nonce': nonce,
            'x-kiosk-signature': sign(ts, nonce, 'GET', PATH, ''),
        }));

        expect(peekFacilityState).toHaveBeenCalled();
        expect(getFullAttendance).not.toHaveBeenCalled();
    });

    it('withholds the building state from a bad signature, and still answers', async () => {
        const { rawPublicHex } = makeKeypair();
        const other = makeKeypair();
        process.env.KIOSK_PUBLIC_KEY = rawPublicHex;
        const ts = String(Math.floor(Date.now() / 1000));
        const nonce = freshNonce();

        const res = await GET(pingReq({
            'x-kiosk-timestamp': ts,
            'x-kiosk-nonce': nonce,
            'x-kiosk-signature': other.sign(ts, nonce, 'GET', PATH, ''),
        }));

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.version).toBeDefined();
        expect(body.facility).toBeUndefined();
    });
});
