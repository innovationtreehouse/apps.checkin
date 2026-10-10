/**
 * @jest-environment node
 */
/**
 * Integration tests for POST /api/webhooks/shopify covering the NEGATIVE and
 * IDEMPOTENCY paths that the happy-path lifecycle test never exercised:
 *   - bad / missing HMAC signature, unconfigured secret, malformed JSON
 *   - participant-not-found (acknowledged, no mutation)
 *   - replaying the same valid payload twice (Shopify retries at-least-once)
 *   - the membership-process activation branch
 *   - comma-separated multi-participant activation
 *   - the program-enrollment Shopify-variant guard (fails closed when the
 *     paid order doesn't contain the program's own variant)
 *   - member-discount-code entitlement, judged at this money event: an
 *     unentitled household's redemption is flagged and not activated
 */
import crypto from 'crypto';
import { POST } from '@/app/api/webhooks/shopify/route';
import prisma from '@/lib/prisma';
import { snapshotBoardSettings } from '@/test-helpers/boardSettings';
import { activateByProcessId } from '@/lib/membership/payment';
import { DEV_MOCK_SHOPIFY_WEBHOOK_SECRET } from '@/lib/config';

jest.mock('@/lib/membership/payment', () => ({
    activateByProcessId: jest.fn().mockResolvedValue(undefined),
}));

// Keep the REAL logIntegrationError (it writes to the DB — the 500-catch test
// below asserts that write) but silence the console logger.
jest.mock('@/lib/logger', () => ({
    ...jest.requireActual('@/lib/logger'),
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const SECRET = 'shopify-test-secret';
const TAG = 'shopify-webhook-test';
const MEMBERSHIP_VARIANT_ID = '778899';
const PROGRAM_VARIANT_ID = '445566';
const OTHER_VARIANT_ID = '999999'; // cheapest-item-in-the-store stand-in — never matches the program

function sign(body: string, secret = SECRET): string {
    return crypto.createHmac('sha256', secret).update(body, 'utf8').digest('base64');
}

function webhookReq(body: string, signature: string | null, ip?: string) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'x-shopify-topic': 'orders/paid' };
    if (signature !== null) headers['x-shopify-hmac-sha256'] = signature;
    if (ip) headers['x-forwarded-for'] = ip;
    return new Request('http://localhost/api/webhooks/shopify', {
        method: 'POST',
        headers,
        body,
    });
}

describe('POST /api/webhooks/shopify — negatives & idempotency', () => {
    let programId: number;
    let p1: number;
    let p2: number;
    let h1: number;
    let h2: number;
    let restoreBoardSettings: () => Promise<void> = async () => {};

    beforeAll(async () => {
        // shopifyVariantId is the variant the enroll flow's checkout link is
        // built from — seed it so the guard under test has something to match
        // line_items against.
        // endAt "now": membership coverage always reaches it, whatever
        // orgMembershipYearBoundary a concurrently-running suite has installed
        // on the shared BoardSettings row (a boundary's next occurrence is
        // never in the past, so the dues-settled test can't lose that race).
        const program = await prisma.program.create({
            data: { startAt: new Date('2026-01-01'), endAt: new Date(), name: `Webhook Test Program ${TAG}`, enrollmentStatus: 'OPEN', shopifyVariantId: PROGRAM_VARIANT_ID },
        });
        programId = program.id;

        const a = await prisma.person.create({
            data: { name: 'Hook P1', email: `p1-${TAG}@example.com`, household: { create: { name: "Test HH" } } },
        });
        p1 = a.id;
        h1 = a.householdId;
        const b = await prisma.person.create({
            data: { name: 'Hook P2', email: `p2-${TAG}@example.com`, household: { create: { name: "Test HH" } } },
        });
        p2 = b.id;
        h2 = b.householdId;

        // Route now checks the order's line items against BoardSettings'
        // configured membership variant id(s) — seed one so the routing test
        // below can prove a matching order activates.
        // No year boundary, so an ACTIVE membership covers every program end date.
        restoreBoardSettings = await snapshotBoardSettings();
        await prisma.boardSettings.upsert({
            where: { id: 1 },
            create: { id: 1, orgMembershipVariantId: MEMBERSHIP_VARIANT_ID, orgMembershipYearBoundary: null },
            update: { orgMembershipVariantId: MEMBERSHIP_VARIANT_ID, orgMembershipYearBoundary: null },
        });
    });

    beforeEach(() => {
        jest.clearAllMocks();
        process.env.SHOPIFY_WEBHOOK_SECRET = SECRET;
    });

    afterAll(async () => {
        await restoreBoardSettings();
        await prisma.integrationErrorLog.deleteMany({ where: { source: 'shopify-webhook' } });
        await prisma.paymentException.deleteMany({ where: { programId } });
        await prisma.programParticipant.deleteMany({ where: { programId } });
        await prisma.program.delete({ where: { id: programId } });
        await prisma.person.deleteMany({ where: { id: { in: [p1, p2] } } });
        await prisma.household.deleteMany({ where: { id: { in: [h1, h2] } } });
    });

    async function setPending(participantId: number) {
        await prisma.programParticipant.upsert({
            where: { programId_personId: { programId, personId: participantId } },
            update: { status: 'PENDING', pendingSince: new Date() },
            create: { programId, personId: participantId, status: 'PENDING', pendingSince: new Date() },
        });
    }

    // Defaults to a line item matching the program's own variant, since most
    // tests here aren't exercising the variant guard — pass variantId: null for
    // no line items, or an explicit mismatched id, to exercise it.
    function programPayload(accountIds: string, variantId: string | null = PROGRAM_VARIANT_ID, discountCodes?: string[]) {
        return JSON.stringify({
            financial_status: 'paid',
            id: 555,
            ...(variantId ? { line_items: [{ variant_id: variantId, quantity: accountIds.split(',').length }] } : {}),
            ...(discountCodes ? { discount_codes: discountCodes.map((code) => ({ code })) } : {}),
            note_attributes: [
                { name: 'CheckMeIn_Account_ID', value: accountIds },
                { name: 'Program_ID', value: String(programId) },
            ],
        });
    }

    it('returns 500 when the webhook secret is not configured on a real (non-mock) instance', async () => {
        // The dev orders/paid mock supplies a fixed fallback secret when Shopify is
        // unconfigured on a non-prod instance, so "no secret → 500" only holds off
        // the mock. Wire store creds so shopifyMockActive() is false, then a missing
        // webhook secret is a real misconfiguration → 500.
        delete process.env.SHOPIFY_WEBHOOK_SECRET;
        process.env.SHOPIFY_STORE_DOMAIN = 'test.myshopify.com';
        process.env.SHOPIFY_CLIENT_ID = 'test-client-id';
        process.env.SHOPIFY_CLIENT_SECRET = 'test-client-secret';
        try {
            const body = programPayload(String(p1));
            const res = await POST(webhookReq(body, sign(body)));
            expect(res.status).toBe(500);
        } finally {
            delete process.env.SHOPIFY_STORE_DOMAIN;
            delete process.env.SHOPIFY_CLIENT_ID;
            delete process.env.SHOPIFY_CLIENT_SECRET;
        }
    });

    it('accepts a mock-signed webhook on local (dev orders/paid mock)', async () => {
        // On local (CHECKIN_ENV=local), shopifyWebhookSecret() falls back to the fixed
        // mock secret so the mock's self-signed webhook verifies for real — the symmetry
        // /api/dev/shopify/orders-paid relies on. Bad signature still 401s; a correctly
        // mock-signed body passes verification (200). The mock is gated on the env, not
        // on cred presence, so run this test as local.
        delete process.env.SHOPIFY_WEBHOOK_SECRET;
        const prevEnv = process.env.CHECKIN_ENV;
        process.env.CHECKIN_ENV = 'local';
        // Imported so signer and verifier track the same constant — the value
        // itself is not a contract; this test asserts the fallback wiring.
        const MOCK_SECRET = DEV_MOCK_SHOPIFY_WEBHOOK_SECRET;
        try {
            const body = programPayload(String(p1));
            expect((await POST(webhookReq(body, sign(body)))).status).toBe(401); // signed with the wrong secret
            expect((await POST(webhookReq(body, sign(body, MOCK_SECRET)))).status).toBe(200); // signed with the mock secret
        } finally {
            process.env.SHOPIFY_WEBHOOK_SECRET = SECRET;
            if (prevEnv === undefined) delete process.env.CHECKIN_ENV;
            else process.env.CHECKIN_ENV = prevEnv;
        }
    });

    it('returns 401 when the signature header is missing', async () => {
        const body = programPayload(String(p1));
        const res = await POST(webhookReq(body, null));
        expect(res.status).toBe(401);
    });

    it('returns 401 on a signature mismatch', async () => {
        const body = programPayload(String(p1));
        const res = await POST(webhookReq(body, sign(body, 'wrong-secret')));
        expect(res.status).toBe(401);
    });

    it('returns 400 on a malformed JSON body with a valid signature', async () => {
        const body = 'not-json';
        const res = await POST(webhookReq(body, sign(body)));
        expect(res.status).toBe(400);
    });

    it('acknowledges (200) but makes no change when the participant is not enrolled', async () => {
        // p1 has no programParticipant row for this program yet.
        await prisma.programParticipant.deleteMany({ where: { programId, personId: p1 } });
        const body = programPayload(String(p1));
        const res = await POST(webhookReq(body, sign(body)));
        expect(res.status).toBe(200);

        const row = await prisma.programParticipant.findUnique({
            where: { programId_personId: { programId, personId: p1 } },
        });
        expect(row).toBeNull();
    });

    it('activates a PENDING participant and is idempotent across a replayed delivery', async () => {
        // Line items (via programPayload's default) contain the program's own
        // Shopify variant — the guard under test is satisfied.
        await setPending(p1);
        const body = programPayload(String(p1));

        const first = await POST(webhookReq(body, sign(body)));
        expect(first.status).toBe(200);
        let row = await prisma.programParticipant.findUnique({
            where: { programId_personId: { programId, personId: p1 } },
        });
        expect(row?.status).toBe('ACTIVE');
        expect(row?.pendingSince).toBeNull();

        // Shopify retries at-least-once: replay the identical signed payload.
        const second = await POST(webhookReq(body, sign(body)));
        expect(second.status).toBe(200);
        row = await prisma.programParticipant.findUnique({
            where: { programId_personId: { programId, personId: p1 } },
        });
        // Still ACTIVE, still cleared — replay must not error or regress state.
        expect(row?.status).toBe('ACTIVE');
        expect(row?.pendingSince).toBeNull();
    });

    it('activates every id in a comma-separated CheckMeIn_Account_ID list', async () => {
        await setPending(p1);
        await setPending(p2);
        const body = programPayload(`${p1}, ${p2}`);

        const res = await POST(webhookReq(body, sign(body)));
        expect(res.status).toBe(200);

        const rows = await prisma.programParticipant.findMany({
            where: { programId, personId: { in: [p1, p2] } },
        });
        expect(rows).toHaveLength(2);
        expect(rows.every(r => r.status === 'ACTIVE')).toBe(true);
    });

    it('does NOT activate a PENDING participant when the paid order does not contain the program\'s Shopify variant (fails closed)', async () => {
        // The core regression test: note_attributes alone (CheckMeIn_Account_ID /
        // Program_ID) are customer-controlled and must NOT be enough to activate —
        // the order's line_items have to actually contain the program's variant.
        // Here they carry an unrelated (cheaper) variant instead.
        await setPending(p1);
        const body = programPayload(String(p1), OTHER_VARIANT_ID);

        const res = await POST(webhookReq(body, sign(body)));
        expect(res.status).toBe(200); // still acks Shopify — only the DB state-change is gated

        const row = await prisma.programParticipant.findUnique({
            where: { programId_personId: { programId, personId: p1 } },
        });
        expect(row?.status).toBe('PENDING');
        expect(row?.pendingSince).not.toBeNull();
    });

    describe('order entitlement (shared with the reconciler)', () => {
        const statusOf = async (personId: number) =>
            (await prisma.programParticipant.findUnique({ where: { programId_personId: { programId, personId } } }))?.status;
        const exceptionKinds = async () =>
            (await prisma.paymentException.findMany({ where: { shopifyOrderId: '555' } })).map((e) => e.kind);
        afterEach(async () => {
            await prisma.paymentException.deleteMany({ where: { shopifyOrderId: '555' } });
        });

        it('raises NO_ITEM when the order lacks the program variant', async () => {
            await setPending(p1);
            const body = programPayload(String(p1), OTHER_VARIANT_ID);
            await POST(webhookReq(body, sign(body)));
            expect(await statusOf(p1)).toBe('PENDING');
            expect(await exceptionKinds()).toEqual(['NO_ITEM']);
        });

        it('activates nobody and raises AMOUNT_MISMATCH when the order buys fewer seats than people named', async () => {
            await setPending(p1);
            await setPending(p2);
            const body = JSON.stringify({
                id: 555,
                financial_status: 'paid',
                line_items: [{ variant_id: PROGRAM_VARIANT_ID, quantity: 1 }],
                note_attributes: [
                    { name: 'CheckMeIn_Account_ID', value: `${p1},${p2}` },
                    { name: 'Program_ID', value: String(programId) },
                ],
            });
            await POST(webhookReq(body, sign(body)));
            expect(await statusOf(p1)).toBe('PENDING');
            expect(await statusOf(p2)).toBe('PENDING');
            expect(await exceptionKinds()).toEqual(['AMOUNT_MISMATCH']);
        });

        it.each([
            ['lacks the program variant', OTHER_VARIANT_ID, {}],
            ['was refunded', PROGRAM_VARIANT_ID, { financial_status: 'refunded' }],
        ])('raises nothing for an order that %s when nobody named is awaiting payment', async (_label, variantId, extra) => {
            await prisma.programParticipant.upsert({
                where: { programId_personId: { programId, personId: p1 } },
                update: { status: 'ACTIVE', pendingSince: null },
                create: { programId, personId: p1, status: 'ACTIVE' },
            });
            const body = JSON.stringify({ ...JSON.parse(programPayload(String(p1), variantId)), ...extra });
            await POST(webhookReq(body, sign(body)));
            expect(await statusOf(p1)).toBe('ACTIVE');
            expect(await exceptionKinds()).toEqual([]);
        });

        it.each([
            ['an unpaid financial_status', 'orders/paid', { financial_status: 'pending' }],
            ['a refunded financial_status', 'orders/paid', { financial_status: 'partially_refunded' }],
            ['a cancelled order', 'orders/paid', { financial_status: 'paid', cancelled_at: '2026-10-01T00:00:00Z' }],
            ['a topic other than orders/paid', 'orders/create', { financial_status: 'paid' }],
        ])('ignores %s without activating or raising', async (_label, topic, extra) => {
            await setPending(p1);
            const body = JSON.stringify({ ...JSON.parse(programPayload(String(p1))), ...extra });
            const req = webhookReq(body, sign(body));
            req.headers.set('x-shopify-topic', topic);
            const res = await POST(req);
            expect(res.status).toBe(200);
            expect(await statusOf(p1)).toBe('PENDING');
            expect(await exceptionKinds()).toEqual([]);
        });
    });

    it('flags DISCOUNT_UNAUTHORIZED and does NOT activate when the order redeems the program member code from an unentitled household', async () => {
        // Member-code entitlement is judged HERE, at the money event — seconds after
        // checkout, against the household's state at the sale. h1 holds no
        // OrgMembership, so it is not dues-settled through the program's dates.
        await setPending(p1);
        const body = programPayload(String(p1), PROGRAM_VARIANT_ID, [`PRG${programId}-ABCD1234`]);
        try {
            const res = await POST(webhookReq(body, sign(body)));
            expect(res.status).toBe(200); // still acks Shopify — only the DB state-change is gated

            const row = await prisma.programParticipant.findUnique({
                where: { programId_personId: { programId, personId: p1 } },
            });
            expect(row?.status).toBe('PENDING');
            const ex = await prisma.paymentException.findFirst({
                where: { kind: 'DISCOUNT_UNAUTHORIZED', shopifyOrderId: '555' },
            });
            expect(ex?.programId).toBe(programId);
            expect(ex?.personId).toBe(p1);

            // A redelivery re-detects the same condition and must not duplicate the row.
            await POST(webhookReq(body, sign(body)));
            expect(await prisma.paymentException.count({ where: { kind: 'DISCOUNT_UNAUTHORIZED', shopifyOrderId: '555' } })).toBe(1);
        } finally {
            await prisma.paymentException.deleteMany({ where: { kind: 'DISCOUNT_UNAUTHORIZED', shopifyOrderId: '555' } });
        }
    });

    it('still flags when a dues-settled person id is STUFFED into CheckMeIn_Account_ID by an unentitled enrollee', async () => {
        // The permalink attack: CheckMeIn_Account_ID is customer-controlled, so the
        // attacker appends any settled person's id (autoincrement — easy to guess) to
        // their own. That person is not enrolled in this program, so they cannot lend
        // their entitlement; activateProgramEnrollment would ignore them and activate
        // the attacker. Entitlement is judged over the DB's enrollees, not the payload.
        await setPending(p1);
        const outsider = await prisma.person.create({
            data: { name: 'Settled Outsider', email: `outsider-${TAG}@example.com`, household: { create: { name: 'Settled HH' } } },
        });
        try {
            await prisma.orgMembership.create({ data: { householdId: outsider.householdId, status: 'ACTIVE' } });
            const body = programPayload(`${p1},${outsider.id}`, PROGRAM_VARIANT_ID, [`PRG${programId}-ABCD1234`]);
            const res = await POST(webhookReq(body, sign(body)));
            expect(res.status).toBe(200);

            const row = await prisma.programParticipant.findUnique({
                where: { programId_personId: { programId, personId: p1 } },
            });
            expect(row?.status).toBe('PENDING');
            expect(await prisma.paymentException.count({ where: { kind: 'DISCOUNT_UNAUTHORIZED', shopifyOrderId: '555' } })).toBe(1);
        } finally {
            await prisma.paymentException.deleteMany({ where: { kind: 'DISCOUNT_UNAUTHORIZED', shopifyOrderId: '555' } });
            await prisma.orgMembership.deleteMany({ where: { householdId: outsider.householdId } });
            await prisma.person.delete({ where: { id: outsider.id } });
            await prisma.household.delete({ where: { id: outsider.householdId } });
        }
    });

    it('activates as usual when the same member code comes from a dues-settled household', async () => {
        // The entitled half of the same judgement: the code is only evidence when the
        // paying family has no membership behind it.
        await setPending(p1);
        const membership = await prisma.orgMembership.create({ data: { householdId: h1, status: 'ACTIVE' } });
        const body = programPayload(String(p1), PROGRAM_VARIANT_ID, [`PRG${programId}-ABCD1234`]);
        try {
            const res = await POST(webhookReq(body, sign(body)));
            expect(res.status).toBe(200);

            const row = await prisma.programParticipant.findUnique({
                where: { programId_personId: { programId, personId: p1 } },
            });
            expect(row?.status).toBe('ACTIVE');
            expect(await prisma.paymentException.count({ where: { kind: 'DISCOUNT_UNAUTHORIZED', shopifyOrderId: '555' } })).toBe(0);
        } finally {
            await prisma.orgMembership.delete({ where: { id: membership.id } });
        }
    });

    it('fails closed when the Program has no Shopify variant configured at all', async () => {
        // "Cannot verify" must mean "don't activate", not "trust the payload".
        const noVariantProgram = await prisma.program.create({
            data: { startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: `Webhook Test No-Variant Program ${TAG}`, enrollmentStatus: 'OPEN' },
        });
        try {
            await prisma.programParticipant.create({
                data: { programId: noVariantProgram.id, personId: p1, status: 'PENDING', pendingSince: new Date() },
            });
            const body = JSON.stringify({
            financial_status: 'paid',
                id: 654,
                line_items: [{ variant_id: PROGRAM_VARIANT_ID }], // even a "valid-looking" variant can't match — nothing configured
                note_attributes: [
                    { name: 'CheckMeIn_Account_ID', value: String(p1) },
                    { name: 'Program_ID', value: String(noVariantProgram.id) },
                ],
            });
            const res = await POST(webhookReq(body, sign(body)));
            expect(res.status).toBe(200);

            const row = await prisma.programParticipant.findUnique({
                where: { programId_personId: { programId: noVariantProgram.id, personId: p1 } },
            });
            expect(row?.status).toBe('PENDING');
            expect(row?.pendingSince).not.toBeNull();
        } finally {
            await prisma.programParticipant.deleteMany({ where: { programId: noVariantProgram.id } });
            await prisma.program.delete({ where: { id: noVariantProgram.id } });
        }
    });

    it('rate-limits a flood (429 + Retry-After) AHEAD of the HMAC check — bad sig still 429, not 401', async () => {
        // route.ts: rateLimit(..., { limit: 60, windowMs: 60_000 }) runs BEFORE the
        // signature verify. Flood from a dedicated IP (own bucket, no leak into the
        // other cases) with a DELIBERATELY BAD signature: the first 60 burn the
        // window returning 401 (bad sig), the 61st is rejected at the limiter.
        const ip = '198.51.100.21';
        const body = programPayload(String(p1));
        const badSig = sign(body, 'wrong-secret');

        for (let i = 0; i < 60; i++) {
            const res = await POST(webhookReq(body, badSig, ip));
            expect(res.status).toBe(401); // limiter not yet tripped → reaches HMAC, fails it
        }

        const limited = await POST(webhookReq(body, badSig, ip));
        // 429 (limiter), NOT 401 (HMAC) — proves the limiter precedes signature verify.
        expect(limited.status).toBe(429);
        expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThan(0);
    });

    it('routes a Membership_Process_ID payload to activateByProcessId and returns 200', async () => {
        const body = JSON.stringify({
            financial_status: 'paid',
            id: 98765,
            line_items: [{ variant_id: MEMBERSHIP_VARIANT_ID }],
            note_attributes: [{ name: 'Membership_Process_ID', value: '42' }],
        });
        const res = await POST(webhookReq(body, sign(body)));
        expect(res.status).toBe(200);
        // H2: whether the order actually contains the configured membership variant
        // is forwarded so activate() can enforce it.
        expect(activateByProcessId).toHaveBeenCalledWith(42, '98765', true);
    });

    it('returns 500 and writes one IntegrationErrorLog row when a handler throws', async () => {
        // Clean slate so the survivor count is exact.
        await prisma.integrationErrorLog.deleteMany({ where: { source: 'shopify-webhook' } });
        (activateByProcessId as jest.Mock).mockRejectedValueOnce(new Error('handler boom'));

        const body = JSON.stringify({
            financial_status: 'paid',
            id: 13579,
            note_attributes: [{ name: 'Membership_Process_ID', value: '99' }],
        });
        const res = await POST(webhookReq(body, sign(body)));
        expect(res.status).toBe(500);

        const rows = await prisma.integrationErrorLog.findMany({ where: { source: 'shopify-webhook' } });
        expect(rows).toHaveLength(1);
        expect(rows[0].message).toBe('handler boom');
        expect(rows[0].context).toEqual({ operation: 'POST /api/webhooks/shopify' });
    });

    // Single-pool model (product decision 2026-07-06): activation needs NO
    // inventory mirror call at all — there's exactly one pool, and Shopify
    // already auto-decremented it on the sale.
    describe('single-pool model (shopifyVariantId)', () => {
        let singlePoolProgramId: number;
        let sgp1: number;
        let sgh1: number;
        const SINGLE_VARIANT_ID = '556677';

        beforeAll(async () => {
            const program = await prisma.program.create({
                data: { startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: `Webhook Single-Pool Test Program ${TAG}`, enrollmentStatus: 'OPEN', shopifyVariantId: SINGLE_VARIANT_ID },
            });
            singlePoolProgramId = program.id;

            const a = await prisma.person.create({
                data: { name: 'Single Pool P1', email: `sgp1-${TAG}@example.com`, household: { create: { name: "Test HH" } } },
            });
            sgp1 = a.id;
            sgh1 = a.householdId;
        });

        afterAll(async () => {
            await prisma.programParticipant.deleteMany({ where: { programId: singlePoolProgramId } });
            await prisma.program.delete({ where: { id: singlePoolProgramId } });
            await prisma.person.deleteMany({ where: { id: sgp1 } });
            await prisma.household.deleteMany({ where: { id: sgh1 } });
        });

        it('activates on a shopifyVariantId match with no mirror call (single pool, no sibling)', async () => {
            const prevEnv = process.env.CHECKIN_ENV;
            // Arms config.shopifyMockActive() so a mirror call (if any fired) would
            // log rather than hit a real API — asserting its ABSENCE below.
            process.env.CHECKIN_ENV = 'local';
            const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
            try {
                await prisma.programParticipant.upsert({
                    where: { programId_personId: { programId: singlePoolProgramId, personId: sgp1 } },
                    update: { status: 'PENDING', pendingSince: new Date() },
                    create: { programId: singlePoolProgramId, personId: sgp1, status: 'PENDING', pendingSince: new Date() },
                });
                const body = JSON.stringify({
            financial_status: 'paid',
                    id: 888,
                    line_items: [{ variant_id: SINGLE_VARIANT_ID }],
                    note_attributes: [
                        { name: 'CheckMeIn_Account_ID', value: String(sgp1) },
                        { name: 'Program_ID', value: String(singlePoolProgramId) },
                    ],
                });

                const res = await POST(webhookReq(body, sign(body)));
                expect(res.status).toBe(200);

                const row = await prisma.programParticipant.findUnique({
                    where: { programId_personId: { programId: singlePoolProgramId, personId: sgp1 } },
                });
                expect(row?.status).toBe('ACTIVE');

                // No mirror/adjust call at all — single pool, Shopify already decremented it.
                expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('Would adjust inventory'));
            } finally {
                logSpy.mockRestore();
                if (prevEnv === undefined) delete process.env.CHECKIN_ENV;
                else process.env.CHECKIN_ENV = prevEnv;
            }
        });

        // Hold-ledger (product decision 2026-07-06): release path (b) — a denied
        // scholarship applicant who pays anyway (inventoryHeldAt still set from
        // application time) gets that hold released (+1) to compensate Shopify's
        // real sale, which just auto-decremented a SECOND unit for the same seat.
        // Without this, every denied-then-paying applicant leaks a seat.
        it('activates AND releases the scholarship hold (+1) when a denied applicant pays anyway', async () => {
            const prevEnv = process.env.CHECKIN_ENV;
            process.env.CHECKIN_ENV = 'local';
            const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
            try {
                await prisma.programParticipant.upsert({
                    where: { programId_personId: { programId: singlePoolProgramId, personId: sgp1 } },
                    update: { status: 'PENDING', pendingSince: new Date(), isPaymentPlanRequested: false, inventoryHeldAt: new Date(), paymentPlanDeniedAt: new Date() },
                    create: { programId: singlePoolProgramId, personId: sgp1, status: 'PENDING', pendingSince: new Date(), isPaymentPlanRequested: false, inventoryHeldAt: new Date(), paymentPlanDeniedAt: new Date() },
                });
                const body = JSON.stringify({
            financial_status: 'paid',
                    id: 889,
                    line_items: [{ variant_id: SINGLE_VARIANT_ID }],
                    note_attributes: [
                        { name: 'CheckMeIn_Account_ID', value: String(sgp1) },
                        { name: 'Program_ID', value: String(singlePoolProgramId) },
                    ],
                });

                const res = await POST(webhookReq(body, sign(body)));
                expect(res.status).toBe(200);

                const row = await prisma.programParticipant.findUnique({
                    where: { programId_personId: { programId: singlePoolProgramId, personId: sgp1 } },
                });
                expect(row?.status).toBe('ACTIVE');
                expect(row?.inventoryHeldAt).toBeNull(); // hold released

                expect(logSpy).toHaveBeenCalledWith(
                    expect.stringContaining(`Would adjust inventory by 1 for variant: ${SINGLE_VARIANT_ID}`),
                );
            } finally {
                logSpy.mockRestore();
                if (prevEnv === undefined) delete process.env.CHECKIN_ENV;
                else process.env.CHECKIN_ENV = prevEnv;
            }
        });
    });
});
