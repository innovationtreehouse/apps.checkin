/**
 * @jest-environment node
 */
/**
 * Integration tests for POST /api/dev/shopify/orders-paid — the dev-only mock
 * that synthesizes an orders/paid payload and self-fires it at the REAL inbound
 * webhook (see docs/ops/shopify-dev-store.md §6). Covers the gate
 * fuses (mock-active, session, validation) plus an end-to-end happy path that
 * proves the mock actually drives activate() via the real webhook handler —
 * not just a mocked 200.
 *
 * The route calls `fetch(config.baseUrl() + '/api/webhooks/shopify')`. There is
 * no live HTTP server bound to that URL in the test process, so `global.fetch`
 * is replaced here with an implementation that routes the exact request the
 * route built (same headers, same raw body) straight into the real inbound
 * `POST` handler — same DB, same HMAC verify, same activate() call prod runs.
 */
import { POST } from '@/app/api/dev/shopify/orders-paid/route';
import { POST as WEBHOOK_POST } from '@/app/api/webhooks/shopify/route';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));

const TAG = 'dev-shopify-route-test';

function asSession(id = 1) {
    (getServerSession as jest.Mock).mockResolvedValue({ user: { id, isSysadmin: false, isBoardMember: false } });
}
function anonymous() {
    (getServerSession as jest.Mock).mockResolvedValue(null);
}
function jsonReq(body?: unknown) {
    return new Request('http://localhost:4000/api/dev/shopify/orders-paid', {
        method: 'POST',
        // A real local browser always carries the session cookie; without it, the
        // local (CHECKIN_ENV=local) kiosk fallback in authenticateRequest treats the
        // cookieless request as a kiosk and withAuth 403s it. Send one so auth resolves
        // to the mocked session, as it would in the app.
        headers: { cookie: 'next-auth.session-token=test' },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
}

describe('POST /api/dev/shopify/orders-paid (dev mock)', () => {
    let originalFetch: typeof global.fetch;
    let prevSettings: { orgMembershipVariantId: string | null } | null;

    async function wipe() {
        const hhs = await prisma.household.findMany({ where: { name: { contains: TAG } }, select: { id: true } });
        const ids = hhs.map((h) => h.id);
        if (ids.length) {
            await prisma.orgMembershipProcess.deleteMany({ where: { orgMembership: { householdId: { in: ids } } } });
            await prisma.orgMembership.deleteMany({ where: { householdId: { in: ids } } });
            await prisma.programParticipant.deleteMany({ where: { person: { householdId: { in: ids } } } });
            await prisma.person.deleteMany({ where: { householdId: { in: ids } } });
            await prisma.household.deleteMany({ where: { id: { in: ids } } });
        }
    }

    /** A fresh household + membership + PENDING_PAYMENT process, matching what the dev UI lists. */
    async function makeProc() {
        const hh = await prisma.household.create({ data: { name: `Dev Mock HH ${TAG}` } });
        const m = await prisma.orgMembership.create({ data: { householdId: hh.id, status: 'NONE', isVolunteerFamily: false } });
        // No bgClearedAt: activate() deterministically lands PENDING_BG_CLEARANCE
        // (not ACTIVE) when it advances — see payment.ts `activating = !!process.bgClearedAt`.
        const p = await prisma.orgMembershipProcess.create({
            data: { orgMembershipId: m.id, kind: 'INITIAL', status: 'PENDING_PAYMENT' },
        });
        return { householdId: hh.id, orgMembershipId: m.id, processId: p.id };
    }

    async function setVariant(variantId: string | null) {
        await prisma.boardSettings.upsert({
            where: { id: 1 },
            create: { id: 1, orgMembershipVariantId: variantId },
            update: { orgMembershipVariantId: variantId },
        });
    }

    // The mock gate needs the three real-store creds ABSENT for every test but the
    // first — and a dev following the runbook has them in .env. Snapshot + clear up
    // front (restored in afterAll) so the suite neither depends on the wiping test
    // running first nor permanently erases ambient creds for later suites.
    const SHOPIFY_ENV_KEYS = ['SHOPIFY_STORE_DOMAIN', 'SHOPIFY_CLIENT_ID', 'SHOPIFY_CLIENT_SECRET'] as const;
    let prevShopifyEnv: Record<string, string | undefined> = {};
    // The mock is gated EXPLICITLY on CHECKIN_ENV=local (config.shopifyMockActiveEnv);
    // the suite default is 'dev'. Run as local so shopifyMockActive() is true.
    let prevCheckinEnv: string | undefined;

    beforeAll(async () => {
        // Capture before anything fallible so afterAll can't restore `undefined`.
        originalFetch = global.fetch;
        prevCheckinEnv = process.env.CHECKIN_ENV;
        process.env.CHECKIN_ENV = 'local';
        prevShopifyEnv = Object.fromEntries(SHOPIFY_ENV_KEYS.map((k) => [k, process.env[k]]));
        for (const k of SHOPIFY_ENV_KEYS) delete process.env[k];

        const existing = await prisma.boardSettings.findUnique({ where: { id: 1 } });
        prevSettings = existing ? { orgMembershipVariantId: existing.orgMembershipVariantId } : null;
        await wipe();

        global.fetch = jest.fn(async (input, init) => {
            const url = String(input);
            // Only the self-fired inbound webhook may pass; anything else reaching
            // global fetch in this suite is a bug — fail it loudly, not by feeding
            // it the webhook handler's response.
            if (!url.endsWith('/api/webhooks/shopify')) throw new Error(`Unexpected fetch in dev-shopify suite: ${url}`);
            const req = new Request(url, init as RequestInit);
            return WEBHOOK_POST(req as never) as unknown as Response;
        }) as unknown as typeof fetch;
    });

    afterAll(async () => {
        await wipe();
        if (prevSettings) {
            await prisma.boardSettings.update({ where: { id: 1 }, data: prevSettings });
        } else {
            // Row didn't exist before this suite — remove what setVariant created
            // so the worker DB is left as found (AGENTS.md: suites self-clean).
            await prisma.boardSettings.deleteMany({ where: { id: 1 } });
        }
        for (const k of SHOPIFY_ENV_KEYS) {
            if (prevShopifyEnv[k] === undefined) delete process.env[k];
            else process.env[k] = prevShopifyEnv[k];
        }
        if (prevCheckinEnv === undefined) delete process.env.CHECKIN_ENV;
        else process.env.CHECKIN_ENV = prevCheckinEnv;
        global.fetch = originalFetch;
        await prisma.$disconnect();
    });

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('404s when not local (dev/prod pay through the real store, not this route)', async () => {
        asSession();
        process.env.CHECKIN_ENV = 'dev';
        try {
            const res = await POST(jsonReq({ processId: 1 }));
            expect(res.status).toBe(404);
        } finally {
            process.env.CHECKIN_ENV = 'local';
        }
    });

    it('401s when there is no session', async () => {
        anonymous();
        const res = await POST(jsonReq({ processId: 1 }));
        expect(res.status).toBe(401);
    });

    it('400s when processId is missing or not an integer', async () => {
        asSession();
        expect((await POST(jsonReq({}))).status).toBe(400);
        expect((await POST(jsonReq({ processId: 'not-a-number' }))).status).toBe(400);
        expect((await POST(jsonReq({ processId: 1.5 }))).status).toBe(400);
    });

    it('404s when the process does not exist', async () => {
        asSession();
        const res = await POST(jsonReq({ processId: 999999999 }));
        expect(res.status).toBe(404);
    });

    it('404s when the process exists but is not PENDING_PAYMENT', async () => {
        asSession();
        const { processId } = await makeProc();
        await prisma.orgMembershipProcess.update({ where: { id: processId }, data: { status: 'PENDING_BG_REVIEW' } });
        const res = await POST(jsonReq({ processId }));
        expect(res.status).toBe(404);
    });

    it('settles via the synthetic mock variant when none is configured on BoardSettings', async () => {
        // A local seed never sets a membership variant; the mock falls back to
        // DEV_MOCK_MEMBERSHIP_VARIANT_ID (config), which the inbound handler echoes,
        // so the membership fee still settles end-to-end instead of dead-ending on a 409.
        asSession();
        await setVariant(null);
        const { processId } = await makeProc();
        const res = await POST(jsonReq({ processId }));
        expect(res.status).toBe(200);
        const proc = await prisma.orgMembershipProcess.findUnique({ where: { id: processId } });
        expect(proc?.status).toBe('PENDING_BG_CLEARANCE');
        expect(proc?.paidAt).not.toBeNull();
    });

    it('200s, fires the real inbound webhook, and advances the process (PENDING_PAYMENT -> PENDING_BG_CLEARANCE)', async () => {
        asSession();
        await setVariant('dev-mock-variant-route-test');
        const { processId } = await makeProc();

        const res = await POST(jsonReq({ processId }));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toEqual({ ok: true, status: 'PENDING_BG_CLEARANCE' });

        // The real proof: the webhook actually ran end-to-end and mutated the DB,
        // not just that the route returned 200.
        const proc = await prisma.orgMembershipProcess.findUnique({ where: { id: processId } });
        expect(proc?.status).toBe('PENDING_BG_CLEARANCE');
        expect(proc?.paidAt).not.toBeNull();
    });

    // fireProgram — the { programId, participantIds } branch was previously
    // untested at the route level (only fireMembership had coverage here).
    // Mirrors the fireMembership suite's structure: same global.fetch stand-in
    // and CHECKIN_ENV/creds wiring from the outer beforeAll, own Program/Person
    // fixtures, self-cleaning in this block's own afterAll.
    describe('fireProgram (program branch)', () => {
        let programId: number;
        let personId: number;
        let householdId: number;

        beforeAll(async () => {
            const hh = await prisma.household.create({ data: { name: `Dev Mock Program HH ${TAG}` } });
            householdId = hh.id;
            const person = await prisma.person.create({ data: { name: 'Dev Mock Participant', household: { connect: { id: hh.id } } } });
            personId = person.id;
            const program = await prisma.program.create({ data: { appliesToYear: 2026, startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: `Dev Mock Program ${TAG}` } });
            programId = program.id;
        });

        afterAll(async () => {
            await prisma.programParticipant.deleteMany({ where: { programId } });
            await prisma.program.delete({ where: { id: programId } });
            await prisma.person.delete({ where: { id: personId } });
            await prisma.household.delete({ where: { id: householdId } });
        });

        afterEach(async () => {
            // Each test below manages its own participant status; leave no
            // PENDING/ACTIVE row behind for the next test in this block.
            await prisma.programParticipant.deleteMany({ where: { programId } });
        });

        it('400s when participantIds is empty', async () => {
            asSession();
            const res = await POST(jsonReq({ programId, participantIds: [] }));
            expect(res.status).toBe(400);
        });

        it('404s when no PENDING participants match', async () => {
            asSession();
            // No ProgramParticipant row exists for personId yet -> nothing PENDING.
            const res = await POST(jsonReq({ programId, participantIds: [personId] }));
            expect(res.status).toBe(404);
        });

        it('409s when the program has no Shopify variant configured', async () => {
            asSession();
            await prisma.programParticipant.create({
                data: { programId, personId, status: 'PENDING', pendingSince: new Date() },
            });

            const res = await POST(jsonReq({ programId, participantIds: [personId] }));
            expect(res.status).toBe(409);

            // Gate held: participant left PENDING, no webhook fired.
            const row = await prisma.programParticipant.findUnique({ where: { programId_personId: { programId, personId } } });
            expect(row?.status).toBe('PENDING');
        });

        // The mock tool must echo the program's shopifyVariantId, or a fully
        // configured program's local mock-pay flow 409s.
        it('200s, fires the real inbound webhook, and activates the PENDING participant', async () => {
            asSession();
            await prisma.program.update({
                where: { id: programId },
                data: { shopifyVariantId: 'dev-mock-variant-route-program-test' },
            });
            await prisma.programParticipant.create({
                data: { programId, personId, status: 'PENDING', pendingSince: new Date() },
            });

            const res = await POST(jsonReq({ programId, participantIds: [personId] }));
            expect(res.status).toBe(200);
            const body = await res.json();
            expect(body).toEqual({ ok: true, participants: [{ personId, status: 'ACTIVE' }] });

            // The real proof: the webhook actually ran end-to-end and mutated the DB.
            const row = await prisma.programParticipant.findUnique({ where: { programId_personId: { programId, personId } } });
            expect(row?.status).toBe('ACTIVE');
            expect(row?.pendingSince).toBeNull();
        });
    });
});
