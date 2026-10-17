/**
 * @jest-environment node
 */
/**
 * Integration tests for the EXTERNAL phase: the Zoho contract webhook,
 * the board external controls, and the advance-to-PENDING_BG_REVIEW logic.
 */

import { POST as ZOHO_WEBHOOK } from '@/app/api/webhooks/zoho/route';
import { POST as BOARD_EXTERNAL } from '@/app/api/membership-ops/applications/external/route';
import { GET as ADMIN_LIST } from '@/app/api/membership-ops/applications/route';
import { GET as MEMBERSHIP_GET } from '@/app/api/membership/route';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));
// Advancing to PENDING_BG_REVIEW pings reviewers; don't hit Resend in tests.
jest.mock('@/lib/email', () => ({ runPaced: (tasks: Array<() => Promise<unknown>>) => Promise.all(tasks.map((t) => t())), sendEmail: jest.fn().mockResolvedValue(true) }));

const TAG = 'membership-external-test';
const SECRET = 'zoho-test-secret';

function asBoard(id: number) {
    (getServerSession as jest.Mock).mockResolvedValue({ user: { id, isSysadmin: false, isBoardMember: true } });
}
function asUser(id: number) {
    (getServerSession as jest.Mock).mockResolvedValue({ user: { id, isSysadmin: false, isBoardMember: false } });
}

function boardReq(body: unknown) {
    return new Request('http://localhost:4000/api/membership-ops/applications/external', {
        method: 'POST',
        body: JSON.stringify(body),
    }) as unknown as Parameters<typeof BOARD_EXTERNAL>[0];
}
function zohoReq(body: unknown, token: string | null, ip?: string) {
    return new Request('http://localhost:4000/api/webhooks/zoho', {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            ...(token ? { 'x-zoho-webhook-token': token } : {}),
            ...(ip ? { 'x-forwarded-for': ip } : {}),
        },
        body: JSON.stringify(body),
    });
}

describe('Membership EXTERNAL phase API', () => {
    let boardId: number;
    let plainUserId: number;
    let hhA: number;
    let hhB: number;
    let procA: number;
    let procB: number;
    const prevSecret = process.env.ZOHO_WEBHOOK_SECRET;

    async function makeProcess(name: string, envelopeId: string) {
        const hh = await prisma.household.create({ data: { name } });
        const m = await prisma.orgMembership.create({ data: { householdId: hh.id, status: 'NONE' } });
        const p = await prisma.orgMembershipProcess.create({
            data: { orgMembershipId: m.id, kind: 'INITIAL', status: 'PENDING_EXTERNAL_ACTION', zohoEnvelopeId: envelopeId },
        });
        return { householdId: hh.id, processId: p.id };
    }

    async function wipe() {
        const hhs = await prisma.household.findMany({ where: { name: { contains: TAG } }, select: { id: true } });
        const ids = hhs.map((h) => h.id);
        if (ids.length) {
            await prisma.orgMembershipProcess.deleteMany({ where: { orgMembership: { householdId: { in: ids } } } });
            await prisma.orgMembership.deleteMany({ where: { householdId: { in: ids } } });
            await prisma.person.deleteMany({ where: { householdId: { in: ids } } });
            await prisma.household.deleteMany({ where: { id: { in: ids } } });
        }
        await prisma.person.deleteMany({ where: { email: { contains: TAG } } });
    }

    beforeAll(async () => {
        process.env.ZOHO_WEBHOOK_SECRET = SECRET;
        await wipe();

        const board = await prisma.person.create({ data: { email: `board-${TAG}@example.com`, name: 'Board', isBoardMember: true, household: { create: { name: "Test HH" } } } });
        boardId = board.id;
        const user = await prisma.person.create({ data: { email: `user-${TAG}@example.com`, name: 'User', household: { create: { name: "Test HH" } } } });
        plainUserId = user.id;

        const a = await makeProcess(`A ${TAG}`, 'zoho-A');
        hhA = a.householdId;
        procA = a.processId;
        const b = await makeProcess(`B ${TAG}`, 'zoho-B');
        hhB = b.householdId;
        procB = b.processId;
    });

    afterAll(async () => {
        await wipe();
        // boardId/userId households
        await prisma.person.deleteMany({ where: { email: { contains: TAG } } });
        if (prevSecret === undefined) delete process.env.ZOHO_WEBHOOK_SECRET;
        else process.env.ZOHO_WEBHOOK_SECRET = prevSecret;
        await prisma.$disconnect();
    });

    it('rejects a board member acting on their OWN household application (COI), with no mutation', async () => {
        // A board member inside the applicant household: marking the contract or the BG
        // consent would advance it to PENDING_PAYMENT with no Zoho envelope, no
        // signature and no consent behind it.
        const insider = await prisma.person.create({
            data: { email: `insider-${TAG}@example.com`, name: 'Insider Board', isBoardMember: true, householdId: hhB },
        });
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: insider.id, isSysadmin: true, isBoardMember: true } });

        for (const action of ['mark-contract', 'mark-bg-consent', 'set-envelope']) {
            const res = await BOARD_EXTERNAL(boardReq({ processId: procB, action, envelopeId: 'zoho-COI' }) as never);
            expect(res.status).toBe(403);
        }

        // Sysadmin is no exemption, and nothing moved.
        const p = await prisma.orgMembershipProcess.findUnique({ where: { id: procB } });
        expect(p?.contractSignedAt).toBeNull();
        expect(p?.bgConsentAt).toBeNull();
        expect(p?.zohoEnvelopeId).toBe('zoho-B');
        expect(p?.status).toBe('PENDING_EXTERNAL_ACTION');
    });

    it('rejects a non-board user from the external controls', async () => {
        asUser(plainUserId);
        const res = await BOARD_EXTERNAL(boardReq({ processId: procA, action: 'mark-contract' }) as never);
        expect(res.status).toBe(403);
    });

    it('marking the contract alone keeps the process in EXTERNAL', async () => {
        asBoard(boardId);
        const res = await BOARD_EXTERNAL(boardReq({ processId: procA, action: 'mark-contract' }) as never);
        expect(res.status).toBe(200);
        const p = await prisma.orgMembershipProcess.findUnique({ where: { id: procA } });
        expect(p?.contractSignedAt).not.toBeNull();
        expect(p?.status).toBe('PENDING_EXTERNAL_ACTION');
    });

    it('marking BG consent after the contract advances to PENDING_PAYMENT', async () => {
        asBoard(boardId);
        const res = await BOARD_EXTERNAL(boardReq({ processId: procA, action: 'mark-bg-consent' }) as never);
        expect(res.status).toBe(200);
        const p = await prisma.orgMembershipProcess.findUnique({ where: { id: procA } });
        expect(p?.bgConsentAt).not.toBeNull();
        expect(p?.status).toBe('PENDING_PAYMENT');
    });

    it('rejects a Zoho webhook with a bad token', async () => {
        const res = await ZOHO_WEBHOOK(zohoReq({ requests: { request_id: 'zoho-B', request_status: 'completed' } }, 'wrong'));
        expect(res.status).toBe(401);
    });

    it('rate-limits a flood (429 + Retry-After) AHEAD of the token check — bad token still 429, not 401', async () => {
        // route.ts: rateLimit(..., { limit: 60, windowMs: 60_000 }) runs BEFORE the
        // token verify. Flood from a dedicated IP (own bucket) with a BAD token:
        // the first 60 burn the window returning 401, the 61st trips the limiter.
        const ip = '198.51.100.42';
        const payload = { requests: { request_id: 'zoho-B', request_status: 'completed' } };

        for (let i = 0; i < 60; i++) {
            const res = await ZOHO_WEBHOOK(zohoReq(payload, 'wrong', ip));
            expect(res.status).toBe(401); // limiter not yet tripped → reaches token verify, fails it
        }

        const limited = await ZOHO_WEBHOOK(zohoReq(payload, 'wrong', ip));
        // 429 (limiter), NOT 401 (token) — proves the limiter precedes token verify.
        expect(limited.status).toBe(429);
        expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThan(0);
    });

    it('a valid completed Zoho webhook records the contract as signed', async () => {
        const res = await ZOHO_WEBHOOK(zohoReq({ requests: { request_id: 'zoho-B', request_status: 'completed' } }, SECRET));
        expect(res.status).toBe(200);
        const p = await prisma.orgMembershipProcess.findUnique({ where: { id: procB } });
        expect(p?.contractSignedAt).not.toBeNull();
        // BG consent not yet given → still EXTERNAL.
        expect(p?.status).toBe('PENDING_EXTERNAL_ACTION');
    });

    it('rejects (500) a completed Zoho webhook when the secret is unset, with no mutation', async () => {
        const { processId } = await makeProcess(`C ${TAG}`, 'zoho-C');
        delete process.env.ZOHO_WEBHOOK_SECRET;
        // On a dev/local instance the mock supplies a default webhook secret, so the
        // unconfigured-500 path is prod-only. Pin CHECKIN_ENV=prod to assert it.
        const prevEnv = process.env.CHECKIN_ENV;
        process.env.CHECKIN_ENV = 'prod';
        try {
            const res = await ZOHO_WEBHOOK(zohoReq({ requests: { request_id: 'zoho-C', request_status: 'completed' } }, SECRET));
            // Route bails before token verify when the secret is unconfigured.
            expect(res.status).toBe(500);
        } finally {
            process.env.ZOHO_WEBHOOK_SECRET = SECRET;
            process.env.CHECKIN_ENV = prevEnv;
        }
        const p = await prisma.orgMembershipProcess.findUnique({ where: { id: processId } });
        expect(p?.contractSignedAt).toBeNull();
        expect(p?.status).toBe('PENDING_EXTERNAL_ACTION');
    });

    it('replaying the same completed Zoho webhook is a safe no-op (no double-advance, single audit row)', async () => {
        const { processId } = await makeProcess(`D ${TAG}`, 'zoho-D');
        const req = () => ZOHO_WEBHOOK(zohoReq({ requests: { request_id: 'zoho-D', request_status: 'completed' } }, SECRET));
        // Fresh process: the contract-signed webhook is the only thing that audits it.
        const auditCount = () =>
            prisma.auditLog.count({ where: { tableName: 'OrgMembershipProcess', affectedEntityId: processId } });

        const first = await req();
        expect(first.status).toBe(200);
        const afterFirst = await prisma.orgMembershipProcess.findUnique({ where: { id: processId } });
        expect(afterFirst?.contractSignedAt).not.toBeNull();
        expect(afterFirst?.status).toBe('PENDING_EXTERNAL_ACTION'); // no BG consent → stays EXTERNAL
        expect(await auditCount()).toBe(1);

        // Zoho retries at-least-once: replay the identical signed payload.
        const second = await req();
        expect(second.status).toBe(200);
        const afterSecond = await prisma.orgMembershipProcess.findUnique({ where: { id: processId } });
        // State identical: same signed timestamp, same phase, no second audit row.
        expect(afterSecond?.contractSignedAt?.getTime()).toBe(afterFirst?.contractSignedAt?.getTime());
        expect(afterSecond?.status).toBe(afterFirst?.status);
        expect(await auditCount()).toBe(1);
    });

    it('ignores a non-completed Zoho event without changing state', async () => {
        const res = await ZOHO_WEBHOOK(zohoReq({ requests: { request_id: 'zoho-B', request_status: 'inprogress' } }, SECRET));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.ignored).toBeDefined();
    });

    it('set-envelope associates a Zoho request id with an unsigned process', async () => {
        const { processId } = await makeProcess(`E ${TAG}`, 'zoho-E');
        asBoard(boardId);
        const res = await BOARD_EXTERNAL(boardReq({ processId, action: 'set-envelope', envelopeId: 'zoho-E2' }) as never);
        expect(res.status).toBe(200);
        const p = await prisma.orgMembershipProcess.findUnique({ where: { id: processId } });
        expect(p?.zohoEnvelopeId).toBe('zoho-E2');
    });

    it('set-envelope refuses a signed process, keeping its envelope', async () => {
        const { processId } = await makeProcess(`F ${TAG}`, 'zoho-F');
        await prisma.orgMembershipProcess.update({ where: { id: processId }, data: { contractSignedAt: new Date() } });
        asBoard(boardId);
        const res = await BOARD_EXTERNAL(boardReq({ processId, action: 'set-envelope', envelopeId: 'zoho-F2' }) as never);
        expect(res.status).toBe(400);
        const p = await prisma.orgMembershipProcess.findUnique({ where: { id: processId } });
        expect(p?.zohoEnvelopeId).toBe('zoho-F');
    });

    it('keeps hhA/hhB distinct (sanity)', () => {
        expect(hhA).not.toBe(hhB);
    });

    it('admin listing rejects a non-board user', async () => {
        asUser(plainUserId);
        const res = await ADMIN_LIST(boardReq({}) as never);
        expect(res.status).toBe(403);
    });

    it('admin listing returns in-flight processes with household + flags for the board', async () => {
        asBoard(boardId);
        const res = await ADMIN_LIST(boardReq({}) as never);
        expect(res.status).toBe(200);
        const data = await res.json();
        const ids = data.processes.map((p: { id: number }) => p.id);
        expect(ids).toEqual(expect.arrayContaining([procA, procB]));
        const a = data.processes.find((p: { id: number }) => p.id === procA);
        expect(a.orgMembership.householdId).toBe(hhA);
        expect(a.status).toBe('PENDING_PAYMENT');
    });
});

/**
 * The background-check "fill-out external" step, applicant + board sides:
 *   1. GET /api/membership surfaces the manual-adapter consent deep link
 *      (external.deepLinkUrl) while the process awaits external action.
 *   2. Board 'mark-bg-consent' records consent and — the contract already being
 *      signed — advances the process EXTERNAL → PENDING_PAYMENT.
 *
 * The background check uses the manual (deep-link) adapter, never Averity's API;
 * AVERITY_CONSENT_URL is set so the real (non-mock) provider hands back a URL.
 */
describe('Membership EXTERNAL phase — background-check step', () => {
    const TAG2 = 'membership-bgconsent-test';
    const AVERITY_URL = 'https://averity.example/consent/treehouse';
    const prevAverity = process.env.AVERITY_CONSENT_URL;

    let boardId2: number;
    let applicantId: number;
    let procId: number;

    async function wipe2() {
        const hhs = await prisma.household.findMany({ where: { name: { contains: TAG2 } }, select: { id: true } });
        const ids = hhs.map((h) => h.id);
        if (ids.length) {
            await prisma.orgMembershipProcess.deleteMany({ where: { orgMembership: { householdId: { in: ids } } } });
            await prisma.orgMembership.deleteMany({ where: { householdId: { in: ids } } });
            await prisma.person.deleteMany({ where: { householdId: { in: ids } } });
            await prisma.household.deleteMany({ where: { id: { in: ids } } });
        }
        await prisma.person.deleteMany({ where: { email: { contains: TAG2 } } });
    }

    beforeAll(async () => {
        // Real (manual) adapter, deterministic URL — no Averity API, no mock page.
        process.env.AVERITY_CONSENT_URL = AVERITY_URL;
        await wipe2();

        const board = await prisma.person.create({ data: { email: `board-${TAG2}@example.com`, name: 'Board', isBoardMember: true, household: { create: { name: "Test HH" } } } });
        boardId2 = board.id;

        // Applicant household with an in-flight process already past the contract:
        // BG consent is the ONLY remaining external action, so marking it is what
        // advances the process — isolating the step under test.
        const hh = await prisma.household.create({ data: { name: `Applicant ${TAG2}` } });
        const applicant = await prisma.person.create({ data: { email: `applicant-${TAG2}@example.com`, name: 'Applicant', householdId: hh.id } });
        applicantId = applicant.id;
        const m = await prisma.orgMembership.create({ data: { householdId: hh.id, status: 'NONE' } });
        const p = await prisma.orgMembershipProcess.create({
            data: { orgMembershipId: m.id, kind: 'INITIAL', status: 'PENDING_EXTERNAL_ACTION', contractSignedAt: new Date() },
        });
        procId = p.id;
    });

    afterAll(async () => {
        await wipe2();
        await prisma.person.deleteMany({ where: { email: { contains: TAG2 } } });
        if (prevAverity === undefined) delete process.env.AVERITY_CONSENT_URL;
        else process.env.AVERITY_CONSENT_URL = prevAverity;
    });

    function membershipGetReq() {
        return new Request('http://localhost:4000/api/membership') as unknown as Parameters<typeof MEMBERSHIP_GET>[0];
    }

    it('applicant GET /api/membership exposes the BG-check consent deep link while awaiting external action', async () => {
        asUser(applicantId);
        const res = await MEMBERSHIP_GET(membershipGetReq() as never);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.process?.status).toBe('PENDING_EXTERNAL_ACTION');
        // The applicant-facing deep link is what ships (manual adapter) — assert on
        // the real field name/shape from getExternalStatus, not a guessed one.
        expect(body.external?.deepLinkUrl).toBe(AVERITY_URL);
        expect(body.external?.bgConsented).toBe(false);
    });

    it('board mark-bg-consent records consent and advances EXTERNAL → PENDING_PAYMENT', async () => {
        asBoard(boardId2);
        const res = await BOARD_EXTERNAL(boardReq({ processId: procId, action: 'mark-bg-consent' }) as never);
        expect(res.status).toBe(200);
        const p = await prisma.orgMembershipProcess.findUnique({ where: { id: procId } });
        expect(p?.bgConsentAt).not.toBeNull();
        expect(p?.status).toBe('PENDING_PAYMENT');
    });

    it('the advance is reflected back to the applicant GET (bgConsented, PENDING_PAYMENT)', async () => {
        asUser(applicantId);
        const res = await MEMBERSHIP_GET(membershipGetReq() as never);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.process?.status).toBe('PENDING_PAYMENT');
        expect(body.external?.bgConsented).toBe(true);
        // Deep link still surfaced — the process is not yet ACTIVE.
        expect(body.external?.deepLinkUrl).toBe(AVERITY_URL);
    });
});
