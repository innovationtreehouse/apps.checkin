/**
 * @jest-environment node
 */
/**
 * Integration tests for POST /api/programs/[id]/sync-shopify — the checkout
 * repair path that mints a Shopify variant for a program that was priced AFTER
 * creation (PATCH never mints variants, so it sits checkout-broken). This was
 * the one fully-built-but-untested route in the program domain; webhookShopify
 * covers inbound MEMBERSHIP webhooks, not this outbound program-category sync.
 *
 * Runs against the CHECKIN_ENV=local Shopify mock (config.shopifyMockActive) so
 * createShopifySingleVariantProgram returns synthetic dev-mock ids instead of
 * hitting the real Admin API — same explicit env gate PR #888 established.
 *
 * NOTE (Q13): this route has NO empty/mis-categorized-category detection. An
 * IntegrationErrorLog row is written only inside the shopify.ts creation
 * functions' catch on a REAL Shopify API failure, which the mock branch never
 * reaches; the route's own catch writes a BackendErrorLog (logBackendError),
 * not an IntegrationErrorLog. So the "empty-category warning surface" is a
 * separate, unbuilt feature — the success-path assertion below pins that no
 * IntegrationErrorLog is emitted here today.
 */
import { POST } from '@/app/api/programs/[id]/sync-shopify/route';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';

jest.mock('next-auth/next', () => ({
    getServerSession: jest.fn(),
}));

const TAG = 'sync-shopify-api-test';
const params = (id: number) => ({ params: Promise.resolve({ id: id.toString() }) }) as unknown as never;
// A cookie header is required: CHECKIN_ENV=local (needed for the Shopify mock)
// also arms the keyless-kiosk fallback in authenticateRequest, which hijacks any
// cookie-less request as `kiosk` → 403 before the session/role gate runs.
const req = () => new Request('http://localhost/api/programs/x/sync-shopify', { method: 'POST', headers: { cookie: 'session=test' } }) as unknown as import('next/server').NextRequest;

describe('POST /api/programs/[id]/sync-shopify', () => {
    let adminId: number;
    let boardId: number;
    let commonId: number;
    let prevCheckinEnv: string | undefined;

    beforeAll(async () => {
        // Route reaches the Shopify MOCK only when CHECKIN_ENV=local (jest.setup
        // sets 'dev'). config reads process.env live per call, so flip it here and
        // restore in afterAll — --runInBand shares the process with sibling suites.
        prevCheckinEnv = process.env.CHECKIN_ENV;
        process.env.CHECKIN_ENV = 'local';

        const admin = await prisma.person.create({
            data: { email: `admin-${TAG}@example.com`, name: 'Admin', isSysadmin: true, household: { create: { name: "Test HH" } } },
        });
        adminId = admin.id;
        const board = await prisma.person.create({
            data: { email: `board-${TAG}@example.com`, name: 'Board', isBoardMember: true, household: { create: { name: "Test HH" } } },
        });
        boardId = board.id;
        const common = await prisma.person.create({
            data: { email: `common-${TAG}@example.com`, name: 'Common', household: { create: { name: "Test HH" } } },
        });
        commonId = common.id;
    });

    afterAll(async () => {
        const ids = [adminId, boardId, commonId];
        await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } });
        await prisma.program.deleteMany({ where: { name: { contains: TAG } } });
        await prisma.person.deleteMany({ where: { id: { in: ids } } });
        process.env.CHECKIN_ENV = prevCheckinEnv;
    });

    // A priced program with no variants — the exact checkout-broken state the
    // route repairs (isProgramCheckoutBroken: price>0 tier, variant null).
    const makeBrokenProgram = () =>
        prisma.program.create({
            data: {
                startAt: new Date('2026-01-01'),
                endAt: new Date('2026-12-31'),
                name: `Broken Prog ${TAG} ${Math.round(performance.now())}`,
                phase: 'RUNNING',
                orgMemberPriceCents: 5000,
                nonOrgMemberPriceCents: 7500,
            },
        });

    it('rejects a caller without isSysadmin/isBoardMember (403)', async () => {
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: commonId } });
        const program = await makeBrokenProgram();

        const res = await POST(req(), params(program.id));
        expect(res.status).toBe(403);

        // Gate held: no variants minted.
        const after = await prisma.program.findUnique({ where: { id: program.id } });
        expect(after?.shopifyProductId).toBeNull();
    });

    it('repairs onto the single-pool model: mints ONE variant and persists shopifyVariantId', async () => {
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: boardId, isBoardMember: true } });
        const program = await makeBrokenProgram(); // no legacy variant set -> new-model repair
        const errLogsBefore = await prisma.integrationErrorLog.count({ where: { source: 'shopify' } });

        const res = await POST(req(), params(program.id));
        expect(res.status).toBe(200);

        const data = await res.json();
        expect(data.success).toBe(true);
        // Success contract: a product id + ONE variant id (single pool), echoed back...
        expect(data.program.shopifyProductId).toMatch(/^dev-mock-product-/);
        expect(data.program.shopifyVariantId).toMatch(/^dev-mock-variant-/);
        // The hidden claimant product is minted alongside it.
        expect(data.program.claimantShopifyVariantId).toMatch(/^dev-mock-claimant-variant-/);

        // ...and PERSISTED — this is what fails if the route stops upserting.
        const persisted = await prisma.program.findUnique({ where: { id: program.id } });
        expect(persisted?.shopifyProductId).toBe(data.program.shopifyProductId);
        expect(persisted?.shopifyVariantId).toBe(data.program.shopifyVariantId);
        expect(persisted?.claimantShopifyVariantId).toBe(data.program.claimantShopifyVariantId);

        // Audit trail written.
        const audit = await prisma.auditLog.findFirst({
            where: { actorId: boardId, tableName: 'Program', affectedEntityId: program.id, action: 'EDIT' },
        });
        expect(audit).not.toBeNull();

        // Q13: no empty-category detection here — the mock never errors, so no
        // IntegrationErrorLog is emitted. Pins current behavior (see file header).
        const errLogsAfter = await prisma.integrationErrorLog.count({ where: { source: 'shopify' } });
        expect(errLogsAfter).toBe(errLogsBefore);
    });

    it('backfills only the claimant product on a program that has its public variant', async () => {
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: adminId, isSysadmin: true } });
        const program = await prisma.program.create({
            data: {
                startAt: new Date('2026-01-01'),
                endAt: new Date('2026-12-31'),
                name: `Pre-claimant Prog ${TAG}`,
                phase: 'RUNNING',
                orgMemberPriceCents: 5000,
                nonOrgMemberPriceCents: 7500,
                shopifyProductId: 'dev-mock-product-existing',
                shopifyVariantId: 'dev-mock-variant-existing',
            },
        });

        const res = await POST(req(), params(program.id));
        expect(res.status).toBe(200);
        const persisted = await prisma.program.findUnique({ where: { id: program.id } });
        expect(persisted?.shopifyVariantId).toBe('dev-mock-variant-existing');
        expect(persisted?.claimantShopifyVariantId).toMatch(/^dev-mock-claimant-variant-/);

        // Idempotent: a second call has nothing left to mint.
        const again = await POST(req(), params(program.id));
        expect(again.status).toBe(400);
    });

    it('refuses a program whose checkout is already configured (400)', async () => {
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: adminId, isSysadmin: true } });
        // Priced AND has both variants -> nothing to mint.
        const program = await prisma.program.create({
            data: {
                startAt: new Date('2026-01-01'),
                endAt: new Date('2026-12-31'),
                name: `Configured Prog ${TAG}`,
                phase: 'RUNNING',
                orgMemberPriceCents: 5000,
                nonOrgMemberPriceCents: 7500,
                shopifyProductId: 'dev-mock-product-existing',
                shopifyVariantId: 'dev-mock-variant-existing',
                claimantShopifyProductId: 'dev-mock-claimant-product-existing',
                claimantShopifyVariantId: 'dev-mock-claimant-variant-existing',
            },
        });

        const res = await POST(req(), params(program.id));
        expect(res.status).toBe(400);
    });

    it('returns 404 for a missing program', async () => {
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: adminId, isSysadmin: true } });
        const res = await POST(req(), params(999_999_999));
        expect(res.status).toBe(404);
    });
});
