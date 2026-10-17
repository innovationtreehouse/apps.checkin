/**
 * Unit tests for verifyKioskSignature — the Ed25519 auth boundary between the
 * kiosk client and the server. Previously ONLY the key parser was tested; the
 * actual crypto verify, timestamp-freshness, tamper, and key-rotation paths
 * were mocked away everywhere. These exercise the real primitive end to end.
 *
 * The signing here mirrors client.py / badge.py exactly:
 *   message = `${timestamp}:${nonce}:${method}:${path}:${body}`  (Ed25519, hex signature)
 *
 * NOTE: the server keeps a module-level seen-nonce cache, so every test that
 * expects success must use a UNIQUE nonce — reusing one trips replay detection.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { verifyKioskSignature } from '../verify-kiosk';

/** Generate an Ed25519 keypair and return the raw 32-byte public key + a signer. */
function makeKeypair() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    // SPKI DER for Ed25519 is a 12-byte prefix + the 32-byte raw key.
    const rawPublic = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
    const sign = (ts: string, nonce: string, method: string, path: string, body: string) =>
        crypto.sign(null, Buffer.from(`${ts}:${nonce}:${method}:${path}:${body}`), privateKey).toString('hex');
    return { rawPublic, sign };
}

const nowSec = () => Math.floor(Date.now() / 1000);

// Unique nonce per call so independent test cases never collide in the cache.
let nonceCounter = 0;
const freshNonce = () => `nonce-${nonceCounter++}`;

describe('verifyKioskSignature', () => {
    it('accepts a correctly signed, fresh request', () => {
        const { rawPublic, sign } = makeKeypair();
        const ts = String(nowSec());
        const nonce = freshNonce();
        const sig = sign(ts, nonce, 'POST', '/api/scan', '{"participantId":5}');
        const res = verifyKioskSignature('POST', '/api/scan', '{"participantId":5}', ts, sig, nonce, rawPublic);
        expect(res.ok).toBe(true);
    });

    it('rejects when the timestamp header is missing', () => {
        const { rawPublic } = makeKeypair();
        const res = verifyKioskSignature('POST', '/api/scan', '', null, 'deadbeef', freshNonce(), rawPublic);
        expect(res).toMatchObject({ ok: false, status: 401, error: 'Missing kiosk signature headers' });
    });

    it('rejects when the signature header is missing', () => {
        const { rawPublic } = makeKeypair();
        const res = verifyKioskSignature('POST', '/api/scan', '', String(nowSec()), null, freshNonce(), rawPublic);
        expect(res).toMatchObject({ ok: false, status: 401, error: 'Missing kiosk signature headers' });
    });

    it('rejects when the nonce header is missing', () => {
        const { rawPublic, sign } = makeKeypair();
        const ts = String(nowSec());
        const sig = sign(ts, 'x', 'POST', '/api/scan', '');
        const res = verifyKioskSignature('POST', '/api/scan', '', ts, sig, null, rawPublic);
        expect(res).toMatchObject({ ok: false, status: 401, error: 'Missing kiosk signature headers' });
    });

    it('rejects a non-numeric timestamp', () => {
        const { rawPublic, sign } = makeKeypair();
        const nonce = freshNonce();
        const sig = sign('abc', nonce, 'POST', '/api/scan', '');
        const res = verifyKioskSignature('POST', '/api/scan', '', 'abc', sig, nonce, rawPublic);
        expect(res).toMatchObject({ ok: false, status: 401, error: 'Invalid timestamp' });
    });

    it('rejects a stale timestamp (replay older than the 60s window)', () => {
        const { rawPublic, sign } = makeKeypair();
        const ts = String(nowSec() - 61);
        const nonce = freshNonce();
        const sig = sign(ts, nonce, 'POST', '/api/scan', '');
        const res = verifyKioskSignature('POST', '/api/scan', '', ts, sig, nonce, rawPublic);
        expect(res).toMatchObject({ ok: false, status: 401 });
        expect((res as { error: string }).error).toMatch(/Timestamp/);
    });

    it('rejects a timestamp too far in the future', () => {
        const { rawPublic, sign } = makeKeypair();
        const ts = String(nowSec() + 61);
        const nonce = freshNonce();
        const sig = sign(ts, nonce, 'POST', '/api/scan', '');
        const res = verifyKioskSignature('POST', '/api/scan', '', ts, sig, nonce, rawPublic);
        expect(res.ok).toBe(false);
    });

    it('accepts at the freshness boundary (exactly 60s old)', () => {
        const { rawPublic, sign } = makeKeypair();
        const ts = String(nowSec() - 60);
        const nonce = freshNonce();
        const sig = sign(ts, nonce, 'POST', '/api/scan', '');
        const res = verifyKioskSignature('POST', '/api/scan', '', ts, sig, nonce, rawPublic);
        expect(res.ok).toBe(true);
    });

    it('rejects when the body was tampered after signing', () => {
        const { rawPublic, sign } = makeKeypair();
        const ts = String(nowSec());
        const nonce = freshNonce();
        const sig = sign(ts, nonce, 'POST', '/api/scan', '{"participantId":5}');
        // Verify against a different body → signature no longer matches.
        const res = verifyKioskSignature('POST', '/api/scan', '{"participantId":6}', ts, sig, nonce, rawPublic);
        expect(res).toMatchObject({ ok: false, status: 401, error: 'Invalid signature' });
    });

    it('rejects when the nonce was swapped after signing', () => {
        const { rawPublic, sign } = makeKeypair();
        const ts = String(nowSec());
        const sig = sign(ts, freshNonce(), 'POST', '/api/scan', '');
        // Present a different nonce than the one that was signed.
        const res = verifyKioskSignature('POST', '/api/scan', '', ts, sig, freshNonce(), rawPublic);
        expect(res).toMatchObject({ ok: false, status: 401, error: 'Invalid signature' });
    });

    it('rejects a signature made by a different key', () => {
        const signer = makeKeypair();
        const attacker = makeKeypair();
        const ts = String(nowSec());
        const nonce = freshNonce();
        const sig = attacker.sign(ts, nonce, 'POST', '/api/scan', '');
        const res = verifyKioskSignature('POST', '/api/scan', '', ts, sig, nonce, signer.rawPublic);
        expect(res).toMatchObject({ ok: false, status: 401, error: 'Invalid signature' });
    });

    it('rejects garbage in the signature field', () => {
        const { rawPublic } = makeKeypair();
        const ts = String(nowSec());
        const res = verifyKioskSignature('POST', '/api/scan', '', ts, 'nothex!!', freshNonce(), rawPublic);
        expect(res.ok).toBe(false);
    });

    it('supports key rotation: accepts if ANY configured key matches', () => {
        const oldKey = makeKeypair();
        const newKey = makeKeypair();
        const ts = String(nowSec());
        const nonce = freshNonce();
        const sig = newKey.sign(ts, nonce, 'POST', '/api/scan', '');
        // Server still lists the old key first, then the new one.
        const res = verifyKioskSignature('POST', '/api/scan', '', ts, sig, nonce, [oldKey.rawPublic, newKey.rawPublic]);
        expect(res.ok).toBe(true);
    });

    it('rejects when none of the configured keys match', () => {
        const a = makeKeypair();
        const b = makeKeypair();
        const signer = makeKeypair();
        const ts = String(nowSec());
        const nonce = freshNonce();
        const sig = signer.sign(ts, nonce, 'POST', '/api/scan', '');
        const res = verifyKioskSignature('POST', '/api/scan', '', ts, sig, nonce, [a.rawPublic, b.rawPublic]);
        expect(res.ok).toBe(false);
    });

    it('rejects a verbatim replay of the same nonce within the window', () => {
        const { rawPublic, sign } = makeKeypair();
        const ts = String(nowSec());
        const nonce = freshNonce();
        const sig = sign(ts, nonce, 'POST', '/api/scan', '{"participantId":5}');
        // First submission is accepted...
        const first = verifyKioskSignature('POST', '/api/scan', '{"participantId":5}', ts, sig, nonce, rawPublic);
        expect(first.ok).toBe(true);
        // ...the identical captured request replayed is rejected.
        const replay = verifyKioskSignature('POST', '/api/scan', '{"participantId":5}', ts, sig, nonce, rawPublic);
        expect(replay).toMatchObject({ ok: false, status: 401, error: 'Replay detected' });
    });

    it('accepts a fresh nonce from the same kiosk after a prior request', () => {
        const { rawPublic, sign } = makeKeypair();
        const ts = String(nowSec());
        const n1 = freshNonce();
        const s1 = sign(ts, n1, 'POST', '/api/scan', '');
        expect(verifyKioskSignature('POST', '/api/scan', '', ts, s1, n1, rawPublic).ok).toBe(true);
        const n2 = freshNonce();
        const s2 = sign(ts, n2, 'POST', '/api/scan', '');
        expect(verifyKioskSignature('POST', '/api/scan', '', ts, s2, n2, rawPublic).ok).toBe(true);
    });
});

/**
 * The other half of the golden vector in client/kiosk-signing-vector.test.json —
 * the Python side is client/test_signing_vector.py. The signature there was
 * produced by PyNaCl from the fixture's test-only key; verifying it here proves
 * the two implementations still agree on the message template, the header
 * meanings, and the hex encoding.
 *
 * The fixture timestamp is fixed and long past, so Date.now is pinned to it for
 * the duration — that keeps the real freshness and replay checks intact instead
 * of routing around them.
 */
describe('kiosk signing contract (golden vector shared with the Python client)', () => {
    const vector = JSON.parse(
        fs.readFileSync(
            path.join(__dirname, '../../../../client/kiosk-signing-vector.test.json'),
            'utf8'
        )
    );
    const publicKey = Buffer.from(vector.test_only_public_key_hex, 'hex');

    beforeAll(() => {
        jest.spyOn(Date, 'now').mockReturnValue(Number(vector.timestamp) * 1000);
    });
    afterAll(() => {
        jest.restoreAllMocks();
    });

    it('verifies the signature the Python client produced', () => {
        const res = verifyKioskSignature(
            vector.method,
            vector.path,
            vector.body,
            vector.timestamp,
            vector.expected_signature_hex,
            vector.nonce,
            publicKey
        );
        expect(res).toEqual({ ok: true });
    });
});
