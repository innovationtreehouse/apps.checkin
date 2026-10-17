/**
 * @jest-environment node
 */
/**
 * Integration tests for POST /api/scan that exercise the REAL authentication
 * and authorization wiring in route.ts — the safety-critical check-in path.
 *
 * Unlike scanRoute.test.ts (jest.mock('@/lib/auth')) and
 * scanCheckin.integration.test.ts (authenticateRequest → { type: 'kiosk' }),
 * this suite does NOT mock @/lib/auth. The real authenticateRequest runs:
 *   - Kiosk path: a real KIOSK_PUBLIC_KEY env + real Ed25519-signed headers,
 *     so verifyKioskSignature actually executes against the route.
 *   - Session path: the already-globally-mocked next-auth/next getServerSession
 *     (the EXTERNAL dependency, not our auth wiring) returns a crafted session
 *     user, so route.ts's session/household-lead authz (lines 37-71) runs for real.
 *
 * The point is to prove route.ts verifies kiosk signatures and enforces
 * who-can-scan-whom — not to re-test the signature primitive (see
 * verifyKioskSignature.test.ts) or the scan state machine (see scanCheckin).
 */
import crypto from 'crypto';
import { POST } from '@/app/api/scan/route';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';
import type { AuthenticatedUser } from '@/types/auth';

// Keep notification / logging side effects out of the DB assertions.
jest.mock('@/lib/notifications', () => ({
    sendCheckinNotifications: jest.fn().mockResolvedValue(undefined),
    sendNotification: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('@/lib/logger', () => ({
    logBackendError: jest.fn(),
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const mockSession = getServerSession as jest.Mock;
const TAG = 'scan-auth-test';

/** Ed25519 keypair mirroring client.py / verifyKioskSignature.test.ts. */
function makeKeypair() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const rawPublicHex = (publicKey.export({ format: 'der', type: 'spki' }) as Buffer)
        .subarray(-32)
        .toString('hex');
    // Mirrors verify-kiosk.ts:80 — nonce is bound INTO the signed payload.
    const sign = (ts: string, nonce: string, method: string, path: string, body: string) =>
        crypto.sign(null, Buffer.from(`${ts}:${nonce}:${method}:${path}:${body}`), privateKey).toString('hex');
    return { rawPublicHex, sign };
}

const nowSec = () => Math.floor(Date.now() / 1000);
// Per-request unique nonce — the verifier rejects reused nonces as replays,
// so every valid-signature case must use a fresh one.
let nonceCounter = 0;
const freshNonce = () => `nonce-${TAG}-${nonceCounter++}`;

/** Build a /api/scan POST request, optionally with kiosk signature headers. */
function scanReq(body: string, headers?: Record<string, string>) {
    return new Request('http://localhost/api/scan', {
        method: 'POST',
        body,
        headers,
    }) as unknown as import('next/server').NextRequest;
}

function sessionUser(overrides: Partial<AuthenticatedUser> & { id: number }): AuthenticatedUser {
    return {
        email: `user-${overrides.id}-${TAG}@example.com`,
        isSysadmin: false,
        isBoardMember: false,
        isKeyholder: false,
        isBackgroundCheckReviewer: false,
        isOperations: false,
        isInventoryManager: false,
        ...overrides,
    };
}

describe('POST /api/scan — REAL auth wiring (no @/lib/auth mock)', () => {
    const ORIG_ENV = process.env.CHECKIN_ENV;
    const ORIG_KEY = process.env.KIOSK_PUBLIC_KEY;

    afterEach(() => {
        mockSession.mockReset();
        mockSession.mockResolvedValue(null);
        process.env.CHECKIN_ENV = ORIG_ENV ?? 'dev';
        if (ORIG_KEY === undefined) delete process.env.KIOSK_PUBLIC_KEY;
        else process.env.KIOSK_PUBLIC_KEY = ORIG_KEY;
    });

    // ────────────────────────────────────────────────────────────────────
    // A. KIOSK SIGNATURE PATH
    // ────────────────────────────────────────────────────────────────────
    describe('A. kiosk signature path', () => {
        let kioskId: number;
        let kioskHouseholdId: number;
        let signer: ReturnType<typeof makeKeypair>;

        beforeAll(async () => {
            // A isKeyholder so a valid kiosk check-in opens the facility → always 200,
            // independent of facility state.
            const k = await prisma.person.create({
                data: {
                    name: 'Kiosk Keyholder',
                    email: `kiosk-${TAG}@example.com`,
                    isKeyholder: true,
                    household: { create: { name: "Test HH" } },
                },
            });
            kioskId = k.id;
            kioskHouseholdId = k.householdId;
        });

        afterAll(async () => {
            await prisma.visit.deleteMany({ where: { personId: kioskId } });
            await prisma.rawBadgeLog.deleteMany({ where: { personId: kioskId } });
            await prisma.person.delete({ where: { id: kioskId } });
            await prisma.household.delete({ where: { id: kioskHouseholdId } });
        });

        beforeEach(() => {
            signer = makeKeypair();
            process.env.KIOSK_PUBLIC_KEY = signer.rawPublicHex;
            process.env.CHECKIN_ENV = 'dev'; // non-local, non-prod: kiosk key required, no keyless fallback
            mockSession.mockResolvedValue(null);
        });

        afterEach(async () => {
            await prisma.visit.deleteMany({ where: { personId: kioskId } });
            await prisma.rawBadgeLog.deleteMany({ where: { personId: kioskId } });
        });

        it('valid signature → 200 and records the check-in', async () => {
            const body = JSON.stringify({ participantId: kioskId });
            const ts = String(nowSec());
            const nonce = freshNonce();
            const sig = signer.sign(ts, nonce, 'POST', '/api/scan', body);

            const res = await POST(scanReq(body, {
                'x-kiosk-timestamp': ts,
                'x-kiosk-nonce': nonce,
                'x-kiosk-signature': sig,
            }));

            expect(res.status).toBe(200);
            const json = await res.json();
            expect(json.type).toBe('checkin');
            expect(json.signedRequest).toBe(true);

            const visit = await prisma.visit.findFirst({ where: { personId: kioskId, departedAt: null } });
            expect(visit).not.toBeNull();
            const events = await prisma.rawBadgeLog.count({ where: { personId: kioskId } });
            expect(events).toBe(1);
        });

        it('tampered body (signed one body, sent another) → 401, no check-in', async () => {
            const signedBody = JSON.stringify({ participantId: kioskId });
            const sentBody = JSON.stringify({ participantId: kioskId, tampered: true });
            const ts = String(nowSec());
            const nonce = freshNonce();
            const sig = signer.sign(ts, nonce, 'POST', '/api/scan', signedBody);

            const res = await POST(scanReq(sentBody, {
                'x-kiosk-timestamp': ts,
                'x-kiosk-nonce': nonce,
                'x-kiosk-signature': sig,
            }));

            expect(res.status).toBe(401);
            const visits = await prisma.visit.count({ where: { personId: kioskId } });
            expect(visits).toBe(0);
        });

        it('stale timestamp (older than the 60s window) → 401', async () => {
            const body = JSON.stringify({ participantId: kioskId });
            const ts = String(nowSec() - 61);
            const nonce = freshNonce();
            const sig = signer.sign(ts, nonce, 'POST', '/api/scan', body); // correctly signed, just stale

            const res = await POST(scanReq(body, {
                'x-kiosk-timestamp': ts,
                'x-kiosk-nonce': nonce,
                'x-kiosk-signature': sig,
            }));

            expect(res.status).toBe(401);
            const visits = await prisma.visit.count({ where: { personId: kioskId } });
            expect(visits).toBe(0);
        });

        it('replayed nonce (same nonce reused across two valid requests) → second 401 "Replay detected"', async () => {
            const nonce = freshNonce(); // deliberately reused below

            const body1 = JSON.stringify({ participantId: kioskId });
            const ts1 = String(nowSec());
            const sig1 = signer.sign(ts1, nonce, 'POST', '/api/scan', body1);
            const res1 = await POST(scanReq(body1, {
                'x-kiosk-timestamp': ts1,
                'x-kiosk-nonce': nonce,
                'x-kiosk-signature': sig1,
            }));
            expect(res1.status).toBe(200); // first use of the nonce: accepted

            // Re-sign with the SAME nonce (fresh timestamp + valid sig), so only the
            // replay cache — not the timestamp window or signature — can reject it.
            const ts2 = String(nowSec());
            const sig2 = signer.sign(ts2, nonce, 'POST', '/api/scan', body1);
            const res2 = await POST(scanReq(body1, {
                'x-kiosk-timestamp': ts2,
                'x-kiosk-nonce': nonce,
                'x-kiosk-signature': sig2,
            }));

            expect(res2.status).toBe(401);
            // Only the first request checked in; the replay changed nothing.
            const events = await prisma.rawBadgeLog.count({ where: { personId: kioskId } });
            expect(events).toBe(1);
        });

        it('missing kiosk headers AND no session cookie, non-local env → 401', async () => {
            // Key configured, but no x-kiosk-signature header and getServerSession → null.
            const body = JSON.stringify({ participantId: kioskId });
            const res = await POST(scanReq(body));

            expect(res.status).toBe(401);
            const visits = await prisma.visit.count({ where: { personId: kioskId } });
            expect(visits).toBe(0);
        });
    });

    // ────────────────────────────────────────────────────────────────────
    // B. SESSION / HOUSEHOLD-LEAD AUTHZ (route.ts:37-71)
    // ────────────────────────────────────────────────────────────────────
    describe('B. session / household-lead authz', () => {
        let pSelf: number, hSelf: number;
        let pSameHH: number, hLead: number;
        let pOtherHH: number, hOther: number;
        let pStranger: number, hStranger: number;
        let pKeyholder: number, hKeyholder: number;

        const LEAD_USER_ID = 999_000_001; // session-only identity; not scanned, never looked up

        beforeAll(async () => {
            // No kiosk key in this suite → forces the session branch (dev is non-local,
            // so the keyless-kiosk fallback stays off and authenticateRequest goes to session).
            delete process.env.KIOSK_PUBLIC_KEY;

            const mk = async (name: string, extra: object = {}) => {
                const p = await prisma.person.create({
                    data: {
                        name,
                        email: `${name.replace(/\s+/g, '-').toLowerCase()}-${TAG}@example.com`,
                        household: { create: { name: "Test HH" } },
                        ...extra,
                    },
                });
                return { id: p.id, householdId: p.householdId };
            };

            ({ id: pSelf, householdId: hSelf } = await mk('Self Member'));
            ({ id: pSameHH, householdId: hLead } = await mk('Same Household Member'));
            ({ id: pOtherHH, householdId: hOther } = await mk('Other Household Member'));
            ({ id: pStranger, householdId: hStranger } = await mk('Stranger'));
            ({ id: pKeyholder, householdId: hKeyholder } = await mk('Open Facility Keyholder', { isKeyholder: true }));
        });

        afterEach(async () => {
            const ids = [pSelf, pSameHH, pOtherHH, pStranger, pKeyholder];
            await prisma.visit.deleteMany({ where: { personId: { in: ids } } });
            await prisma.rawBadgeLog.deleteMany({ where: { personId: { in: ids } } });
        });

        afterAll(async () => {
            const ids = [pSelf, pSameHH, pOtherHH, pStranger, pKeyholder];
            const hs = [hSelf, hLead, hOther, hStranger, hKeyholder];
            await prisma.visit.deleteMany({ where: { personId: { in: ids } } });
            await prisma.rawBadgeLog.deleteMany({ where: { personId: { in: ids } } });
            await prisma.person.deleteMany({ where: { id: { in: ids } } });
            await prisma.household.deleteMany({ where: { id: { in: hs } } });
        });

        /** Open the facility so a non-isKeyholder check-in can reach 200. */
        async function openFacility() {
            await prisma.visit.create({ data: { personId: pKeyholder, arrivedAt: new Date() } });
        }

        it('non-admin scanning self in prod → 403 (self-check-in gate, must use kiosk)', async () => {
            process.env.CHECKIN_ENV = 'prod';
            mockSession.mockResolvedValue({ user: sessionUser({ id: pSelf, householdId: hSelf }) });

            const res = await POST(scanReq(JSON.stringify({ participantId: pSelf })));

            expect(res.status).toBe(403);
            const json = await res.json();
            expect(json.error).toMatch(/kiosk badge scanner/i);
            // Gate fires before any state change.
            expect(await prisma.visit.count({ where: { personId: pSelf } })).toBe(0);
        });

        it('household lead scanning another member of their OWN household → 200', async () => {
            await openFacility();
            mockSession.mockResolvedValue({
                user: sessionUser({ id: LEAD_USER_ID, householdId: hLead, householdLead: true }),
            });

            const res = await POST(scanReq(JSON.stringify({ participantId: pSameHH })));

            expect(res.status).toBe(200);
            const json = await res.json();
            expect(json.type).toBe('checkin');
            const visit = await prisma.visit.findFirst({ where: { personId: pSameHH, departedAt: null } });
            expect(visit).not.toBeNull();
        });

        it('household lead scanning a member of a DIFFERENT household → 403', async () => {
            await openFacility(); // facility open: prove the 403 is authz, not the facility gate
            mockSession.mockResolvedValue({
                user: sessionUser({ id: LEAD_USER_ID, householdId: hLead, householdLead: true }),
            });

            const res = await POST(scanReq(JSON.stringify({ participantId: pOtherHH })));

            expect(res.status).toBe(403);
            const json = await res.json();
            expect(json.error).toMatch(/not authorized/i);
            expect(await prisma.visit.count({ where: { personId: pOtherHH } })).toBe(0);
        });

        it('non-admin non-lead scanning an arbitrary stranger → 403', async () => {
            await openFacility();
            // Plain member: has a household but is NOT its lead.
            mockSession.mockResolvedValue({
                user: sessionUser({ id: LEAD_USER_ID, householdId: hLead, householdLead: false }),
            });

            const res = await POST(scanReq(JSON.stringify({ participantId: pStranger })));

            expect(res.status).toBe(403);
            const json = await res.json();
            expect(json.error).toMatch(/not authorized/i);
            expect(await prisma.visit.count({ where: { personId: pStranger } })).toBe(0);
        });
    });

    // ────────────────────────────────────────────────────────────────────
    // C. RATE LIMIT — abuse surface on the safety-critical scan path
    // ────────────────────────────────────────────────────────────────────
    describe('C. rate limit', () => {
        it('floods past the configured limit → 429 with Retry-After', async () => {
            // route.ts: rateLimit(..., { limit: 300, windowMs: 60_000 }) is the FIRST
            // thing in POST, before auth. Flood from a dedicated IP (own bucket, no
            // leak into other suites). The 301st request is rejected at the limiter.
            const ip = '198.51.100.77';
            const req = () => POST(scanReq(JSON.stringify({ participantId: 1 }), { 'x-forwarded-for': ip }));

            for (let i = 0; i < 300; i++) {
                await req(); // unauthenticated → 401, but each one counts against the window
            }

            const limited = await req();
            expect(limited.status).toBe(429);
            expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThan(0);
        });
    });
});
