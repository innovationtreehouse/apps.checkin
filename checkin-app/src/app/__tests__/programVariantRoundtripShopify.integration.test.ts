/**
 * @jest-environment node
 */
/**
 * Integration test: the FULL round-trip connecting program creation, Shopify
 * variant persistence, and inbound webhook activation as ONE flow.
 *
 * Every existing Shopify test exercises one half in isolation:
 *   - webhookShopify.integration.test.ts seeds a HAND-WRITTEN literal variant id
 *     directly on the Program row, then proves the webhook matches it.
 *   - programSyncShopifyAPI.integration.test.ts (and shopify.test.ts) prove
 *     createShopifySingleVariantProgram mints + persists synthetic mock ids.
 * Neither proves the id MINTED by POST /api/programs is the SAME id the
 * webhook later matches against — this test drives both halves back-to-back:
 * create (mock active) -> assert persisted ids -> sign a webhook payload
 * carrying THOSE EXACT ids -> assert the real inbound handler flips the
 * PENDING participant ACTIVE.
 *
 * Single-pool model (product decision 2026-07-06): program creation now mints
 * ONE variant (shopifyVariantId), not the legacy org/non-org pair — this test
 * was rewritten from the two-variant version it originally covered (see PR
 * body for the design change) to prove the new-model round-trip instead.
 *
 * Also covers the sibling branch: mock inactive + creds absent ->
 * createShopifySingleVariantProgram returns null -> the route falls back to
 * its `warning` response instead of persisting a variant.
 */
import crypto from 'crypto';
import { POST as programsPOST } from '@/app/api/programs/route';
import { POST as webhookPOST } from '@/app/api/webhooks/shopify/route';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';
import { DEV_MOCK_SHOPIFY_WEBHOOK_SECRET } from '@/lib/config';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));
jest.mock('@/lib/notifications', () => ({ sendNotification: jest.fn() }));

const TAG = 'shopify-roundtrip-test';

function programsReq(body: unknown) {
    // CHECKIN_ENV=local also arms the keyless-kiosk fallback in authenticateRequest,
    // which hijacks any cookie-less request as `kiosk` before the role gate runs —
    // send a cookie so auth resolves through the mocked session instead.
    return new Request('http://localhost:4000/api/programs', {
        method: 'POST',
        headers: { cookie: 'session=test' },
        body: JSON.stringify(body),
    }) as unknown as import('next/server').NextRequest;
}

function webhookReq(body: string, secret: string) {
    const signature = crypto.createHmac('sha256', secret).update(body, 'utf8').digest('base64');
    return new Request('http://localhost/api/webhooks/shopify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-shopify-topic': 'orders/paid', 'x-shopify-hmac-sha256': signature },
        body,
    });
}

describe('Shopify variant round-trip: create -> persist -> webhook match', () => {
    let boardId: number;
    let leadId: number;
    let participantId: number;
    const programIds: number[] = [];

    let prevCheckinEnv: string | undefined;
    const SHOPIFY_ENV_KEYS = ['SHOPIFY_WEBHOOK_SECRET', 'SHOPIFY_STORE_DOMAIN', 'SHOPIFY_CLIENT_ID', 'SHOPIFY_CLIENT_SECRET'] as const;
    let prevShopifyEnv: Record<string, string | undefined> = {};

    beforeAll(async () => {
        prevCheckinEnv = process.env.CHECKIN_ENV;
        prevShopifyEnv = Object.fromEntries(SHOPIFY_ENV_KEYS.map((k) => [k, process.env[k]]));
        for (const k of SHOPIFY_ENV_KEYS) delete process.env[k];
        // Mock active requires CHECKIN_ENV=local (config.shopifyMockActiveEnv); the
        // suite default set by jest.setup.js is 'dev' — flip it here, restore in afterAll.
        process.env.CHECKIN_ENV = 'local';

        const board = await prisma.person.create({
            data: { email: `board-${TAG}@example.com`, name: 'Board', isBoardMember: true, household: { create: { name: `Board HH ${TAG}` } } },
        });
        boardId = board.id;
        const lead = await prisma.person.create({
            data: { email: `lead-${TAG}@example.com`, name: 'Lead', isDeclaredAdult: true, household: { create: { name: `Lead HH ${TAG}` } } },
        });
        leadId = lead.id;
        const participant = await prisma.person.create({
            data: { email: `participant-${TAG}@example.com`, name: 'Participant', household: { create: { name: `Participant HH ${TAG}` } } },
        });
        participantId = participant.id;
    });

    afterAll(async () => {
        await prisma.programParticipant.deleteMany({ where: { programId: { in: programIds } } });
        await prisma.auditLog.deleteMany({ where: { actorId: boardId } });
        await prisma.program.deleteMany({ where: { id: { in: programIds } } });
        await prisma.person.deleteMany({ where: { id: { in: [boardId, leadId, participantId] } } });
        await prisma.household.deleteMany({ where: { name: { contains: TAG } } });
        for (const k of SHOPIFY_ENV_KEYS) {
            if (prevShopifyEnv[k] === undefined) delete process.env[k];
            else process.env[k] = prevShopifyEnv[k];
        }
        if (prevCheckinEnv === undefined) delete process.env.CHECKIN_ENV;
        else process.env.CHECKIN_ENV = prevCheckinEnv;
    });

    beforeEach(() => {
        jest.clearAllMocks();
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: boardId, isBoardMember: true } });
    });

    it('mints + persists a synthetic single-pool variant id on create, then a webhook carrying that exact id activates the PENDING participant', async () => {
        const res = await programsPOST(programsReq({
            name: `Roundtrip Program ${TAG}`,
            leadMentorId: leadId,
            startAt: '2026-01-01',
            endAt: '2026-12-31',
            memberPrice: '25.00',
            nonMemberPrice: '35.00',
            maxParticipants: 50,
        }));
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.success).toBe(true);
        expect(data.warning).toBeUndefined();
        programIds.push(data.program.id);

        // Synthetic mock id, not a real Shopify product/variant.
        expect(data.program.shopifyVariantId).toMatch(/^dev-mock-variant-/);

        // Actually PERSISTED, not just echoed in the response.
        const persisted = await prisma.program.findUnique({ where: { id: data.program.id } });
        expect(persisted?.shopifyVariantId).toBe(data.program.shopifyVariantId);

        // Enroll the participant the normal PENDING-awaiting-payment way (what the
        // real enroll flow does before checkout; not the part under test here).
        await prisma.programParticipant.create({
            data: { programId: data.program.id, personId: participantId, status: 'PENDING', pendingSince: new Date() },
        });

        // A real paid order carries the variant id its checkout link was built
        // from — here, THE EXACT id createShopifySingleVariantProgram minted
        // above, not a hand-seeded literal (the gap every other Shopify test
        // leaves open).
        const orderBody = JSON.stringify({
            financial_status: 'paid',
            id: `roundtrip-order-${data.program.id}`,
            line_items: [{ variant_id: data.program.shopifyVariantId }],
            note_attributes: [
                { name: 'CheckMeIn_Account_ID', value: String(participantId) },
                { name: 'Program_ID', value: String(data.program.id) },
            ],
        });
        const hookRes = await webhookPOST(webhookReq(orderBody, DEV_MOCK_SHOPIFY_WEBHOOK_SECRET));
        expect(hookRes.status).toBe(200);

        const participantRow = await prisma.programParticipant.findUnique({
            where: { programId_personId: { programId: data.program.id, personId: participantId } },
        });
        expect(participantRow?.status).toBe('ACTIVE');
        expect(participantRow?.pendingSince).toBeNull();
    });

    it('falls back to the `warning` response when Shopify is unconfigured and the mock is inactive (no variant persisted)', async () => {
        const prevEnv = process.env.CHECKIN_ENV;
        process.env.CHECKIN_ENV = 'dev'; // mock inactive; SHOPIFY_* creds already absent for the whole suite
        try {
            const res = await programsPOST(programsReq({
                name: `Warning Path Program ${TAG}`,
                leadMentorId: leadId,
                startAt: '2026-01-01',
                endAt: '2026-12-31',
                memberPrice: '25.00',
                nonMemberPrice: '35.00',
                maxParticipants: 50,
            }));
            expect(res.status).toBe(200);
            const data = await res.json();
            expect(data.success).toBe(true);
            programIds.push(data.program.id);
            expect(data.warning).toMatch(/Shopify integration failed or is not configured/);
            expect(data.program.shopifyProductId).toBeNull();
            expect(data.program.shopifyVariantId).toBeNull();

            const persisted = await prisma.program.findUnique({ where: { id: data.program.id } });
            expect(persisted?.shopifyVariantId).toBeNull();
        } finally {
            process.env.CHECKIN_ENV = prevEnv;
        }
    });
});
