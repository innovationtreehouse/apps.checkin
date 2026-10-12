/**
 * @jest-environment node
 */
/**
 * Integration tests for the membership payment-plan routes:
 *   GET  /api/finance-ops/membership-payment-plans        (board-only queue)
 *   POST /api/finance-ops/membership-payment-plans         (board approves -> certify/activate)
 *   POST /api/finance-ops/membership-payment-plans/refuse  (board denies -> clear flag, stay PENDING_PAYMENT)
 *   POST /api/membership/request-payment-plan              (request, with IDOR guard)
 *
 * Covers auth rejections (401/403), validation (400/404), the wrong-phase gate
 * (409 off PENDING_PAYMENT), the IDOR path (an unrelated authenticated user
 * requesting on another household's membership), and the successful transitions
 * (flag set on request; certify -> ACTIVE + flag cleared + audit on approve).
 */
import { GET as PlansGet, POST as PlansPost } from '@/app/api/finance-ops/membership-payment-plans/route';
import { POST as DenyPost } from '@/app/api/finance-ops/membership-payment-plans/refuse/route';
import { POST as RequestPost } from '@/app/api/membership/request-payment-plan/route';
import prisma from '@/lib/prisma';
import { snapshotBoardSettings } from '@/test-helpers/boardSettings';
import { DEFAULT_ACK_SUBJECT, DEFAULT_ACK_MEMBERSHIP_BODY, renderAckBody } from '@/lib/scholarshipEmails';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));
jest.mock('@/lib/email');

// eslint-disable-next-line @typescript-eslint/no-require-imports
const mockSession = require('next-auth/next').getServerSession;
// `@/lib/email`'s real module has no __getSentEmails/__clearSentEmails — those
// only exist on the manual mock (src/lib/__mocks__/email.ts) that jest.mock
// above swaps in. jest.requireMock (not a direct import) fetches that swapped
// instance so this typechecks against the mock's own shape.
const { __getSentEmails, __clearSentEmails } =
    jest.requireMock<typeof import('@/lib/__mocks__/email')>('@/lib/email');

const TAG = 'membership-payment-plans-test';

function nextReq(url = 'http://localhost/api/finance-ops/membership-payment-plans', init?: RequestInit) {
    return new Request(url, init) as unknown as import('next/server').NextRequest;
}
function requestReq(body: unknown) {
    return new Request('http://localhost/api/membership/request-payment-plan', {
        method: 'POST',
        body: JSON.stringify(body),
    }) as unknown as import('next/server').NextRequest;
}
function denyReq(body: unknown) {
    return new Request('http://localhost/api/finance-ops/membership-payment-plans/refuse', {
        method: 'POST',
        body: JSON.stringify(body),
    }) as unknown as import('next/server').NextRequest;
}

describe('Membership payment-plan routes', () => {
    let boardId: number;
    let leadId: number;
    let otherId: number;
    // A process the lead's household owns, PENDING_PAYMENT + bgCleared so approval activates.
    let leadProcessId: number;
    let leadMembershipId: number;

    let seq = 0;
    async function makeProc(label: string, opts: { requested: boolean; status?: 'PENDING_PAYMENT' | 'PENDING_BG_REVIEW'; withLead?: boolean }) {
        const n = seq++;
        const hh = await prisma.household.create({ data: { name: `${label}-${n} ${TAG}` } });
        let personId: number | undefined;
        if (opts.withLead) {
            const lead = await prisma.person.create({ data: { email: `lead-${label}-${n}-${TAG}@example.com`, name: 'Lead', householdId: hh.id } });
            await prisma.person.update({ where: { id: lead.id }, data: { isHouseholdLead: true } });
            personId = lead.id;
        }
        const m = await prisma.orgMembership.create({ data: { householdId: hh.id, status: 'NONE', isVolunteer: false } });
        const p = await prisma.orgMembershipProcess.create({
            data: {
                orgMembershipId: m.id,
                kind: 'INITIAL',
                status: opts.status ?? 'PENDING_PAYMENT',
                bgClearedAt: new Date(),
                isPaymentPlanRequested: opts.requested,
            },
        });
        return { householdId: hh.id, orgMembershipId: m.id, processId: p.id, personId };
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
        await wipe();

        const board = await prisma.person.create({
            data: { name: 'MPP Board', email: `board-${TAG}@example.com`, isBoardMember: true, household: { create: { name: `Board ${TAG}` } } },
        });
        boardId = board.id;
        const other = await prisma.person.create({
            data: { name: 'MPP Other', email: `other-${TAG}@example.com`, household: { create: { name: `Other ${TAG}` } } },
        });
        otherId = other.id;
    });

    beforeEach(async () => {
        jest.clearAllMocks();
        __clearSentEmails();
        // Fresh requested + PENDING_PAYMENT process owned by a household lead each
        // test (the approve test mutates it to ACTIVE, so it can't be shared).
        const proc = await makeProc('Lead', { requested: true, withLead: true });
        leadProcessId = proc.processId;
        leadMembershipId = proc.orgMembershipId;
        leadId = proc.personId!;
    });

    afterAll(async () => {
        await wipe();
        await prisma.$disconnect();
    });

    describe('GET /api/finance-ops/membership-payment-plans', () => {
        it('401 without a session', async () => {
            mockSession.mockResolvedValue(null);
            expect((await PlansGet(nextReq())).status).toBe(401);
        });

        it('403 for a non-board, non-sysadmin user', async () => {
            mockSession.mockResolvedValue({ user: { id: otherId } });
            expect((await PlansGet(nextReq())).status).toBe(403);
        });

        it('returns only PENDING_PAYMENT + requested rows to a board member', async () => {
            const notRequested = await makeProc('NoiseUnrequested', { requested: false });
            const wrongPhase = await makeProc('NoiseWrongPhase', { requested: true, status: 'PENDING_BG_REVIEW' });
            mockSession.mockResolvedValue({ user: { id: boardId, isBoardMember: true } });

            const res = await PlansGet(nextReq());
            expect(res.status).toBe(200);
            const ids = (await res.json()).map((r: { id: number }) => r.id);
            expect(ids).toContain(leadProcessId);
            expect(ids).not.toContain(notRequested.processId);
            expect(ids).not.toContain(wrongPhase.processId);
        });
    });

    describe('POST /api/finance-ops/membership-payment-plans (approve)', () => {
        it('401 without a session', async () => {
            mockSession.mockResolvedValue(null);
            expect((await PlansPost(nextReq('http://localhost', { method: 'POST', body: '{}' }))).status).toBe(401);
        });

        it('403 for a non-board user', async () => {
            mockSession.mockResolvedValue({ user: { id: otherId } });
            const res = await PlansPost(nextReq('http://localhost', { method: 'POST', body: JSON.stringify({ processId: leadProcessId }) }));
            expect(res.status).toBe(403);
        });

        it('400 when reason is missing', async () => {
            mockSession.mockResolvedValue({ user: { id: boardId, isBoardMember: true } });
            const res = await PlansPost(nextReq('http://localhost', { method: 'POST', body: JSON.stringify({ processId: leadProcessId }) }));
            expect(res.status).toBe(400);

            const res2 = await PlansPost(nextReq('http://localhost', { method: 'POST', body: JSON.stringify({ processId: leadProcessId, reason: '   ' }) }));
            expect(res2.status).toBe(400);

            const proc = await prisma.orgMembershipProcess.findUnique({ where: { id: leadProcessId } });
            expect(proc?.status).toBe('PENDING_PAYMENT');
        });

        it('409 when there is no pending request for the process', async () => {
            const cleared = await makeProc('Cleared', { requested: false });
            mockSession.mockResolvedValue({ user: { id: boardId, isBoardMember: true } });
            const res = await PlansPost(nextReq('http://localhost', { method: 'POST', body: JSON.stringify({ processId: cleared.processId, reason: 'Board approved scholarship' }) }));
            expect(res.status).toBe(409);
        });

        it('board approval activates the membership, clears the flag, and writes an audit row', async () => {
            mockSession.mockResolvedValue({ user: { id: boardId, isBoardMember: true } });
            const res = await PlansPost(nextReq('http://localhost', { method: 'POST', body: JSON.stringify({ processId: leadProcessId, reason: 'Board approved scholarship' }) }));
            expect(res.status).toBe(200);

            const proc = await prisma.orgMembershipProcess.findUnique({ where: { id: leadProcessId } });
            expect(proc?.status).toBe('ACTIVE'); // bgClearedAt was set, so certify -> ACTIVE
            expect(proc?.isPaymentPlanRequested).toBe(false);
            expect(proc?.manualPaymentById).toBe(boardId);
            expect(proc?.certificationNote).toBe('Board approved scholarship');

            const membership = await prisma.orgMembership.findUnique({ where: { id: leadMembershipId } });
            expect(membership?.status).toBe('ACTIVE');

            const audits = await prisma.auditLog.findMany({
                where: { tableName: 'OrgMembershipProcess', affectedEntityId: leadProcessId, actorId: boardId },
                orderBy: { id: 'asc' },
            });
            expect(audits.length).toBeGreaterThan(0);
            // Written inside activate() (via certifyPaymentPlan) — carries the reason.
            const certifyAudit = audits.find(a => (a.newData as { via?: string })?.via === 'manual');
            expect(certifyAudit).toBeTruthy();
            expect((certifyAudit!.newData as { certificationNote?: string }).certificationNote).toBe('Board approved scholarship');
            // Supplementary marker written by the route itself.
            const approvedAudit = audits.find(a => (a.newData as { paymentPlanApproved?: boolean })?.paymentPlanApproved === true);
            expect(approvedAudit).toBeTruthy();
        });
    });

    describe('POST /api/finance-ops/membership-payment-plans/refuse (deny)', () => {
        it('401 without a session', async () => {
            mockSession.mockResolvedValue(null);
            expect((await DenyPost(denyReq({ processId: leadProcessId }))).status).toBe(401);
        });

        it('403 for a non-board user', async () => {
            mockSession.mockResolvedValue({ user: { id: otherId } });
            expect((await DenyPost(denyReq({ processId: leadProcessId }))).status).toBe(403);
        });

        it('400 when processId is missing', async () => {
            mockSession.mockResolvedValue({ user: { id: boardId, isBoardMember: true } });
            expect((await DenyPost(denyReq({}))).status).toBe(400);
        });

        it('409 when there is no pending request for the process', async () => {
            const cleared = await makeProc('DenyCleared', { requested: false });
            mockSession.mockResolvedValue({ user: { id: boardId, isBoardMember: true } });
            expect((await DenyPost(denyReq({ processId: cleared.processId }))).status).toBe(409);
        });

        it('board denial clears the flag, keeps the process PENDING_PAYMENT, and writes an audit row', async () => {
            mockSession.mockResolvedValue({ user: { id: boardId, isBoardMember: true } });
            const res = await DenyPost(denyReq({ processId: leadProcessId }));
            expect(res.status).toBe(200);

            const proc = await prisma.orgMembershipProcess.findUnique({ where: { id: leadProcessId } });
            expect(proc?.isPaymentPlanRequested).toBe(false);
            expect(proc?.status).toBe('PENDING_PAYMENT'); // stays awaiting payment — no seat, no grace, pay-to-activate
            expect(proc?.manualPaymentById).toBeNull(); // denial never records a payment/activates

            const membership = await prisma.orgMembership.findUnique({ where: { id: leadMembershipId } });
            expect(membership?.status).toBe('NONE'); // untouched by denial

            const audits = await prisma.auditLog.findMany({
                where: { tableName: 'OrgMembershipProcess', affectedEntityId: leadProcessId, actorId: boardId },
            });
            expect(audits.some(a => (a.newData as { paymentPlanDenied?: boolean })?.paymentPlanDenied === true)).toBe(true);
        });

        it('a re-deny of an already-denied (flag false) process is a 409 no-op', async () => {
            mockSession.mockResolvedValue({ user: { id: boardId, isBoardMember: true } });
            expect((await DenyPost(denyReq({ processId: leadProcessId }))).status).toBe(200);
            expect((await DenyPost(denyReq({ processId: leadProcessId }))).status).toBe(409);
        });

        it('404 when the process does not exist', async () => {
            mockSession.mockResolvedValue({ user: { id: boardId, isBoardMember: true } });
            expect((await DenyPost(denyReq({ processId: 999999999 }))).status).toBe(404);
        });

        it('403 (conflict of interest) when a board member denies their OWN household; the request is untouched', async () => {
            const own = await makeProc('DenyCOI', { requested: true });
            const boardKin = await prisma.person.create({
                data: { name: 'Board Kin', email: `board-kin-${own.processId}-${TAG}@example.com`, isBoardMember: true, householdId: own.householdId },
            });
            mockSession.mockResolvedValue({ user: { id: boardKin.id, isBoardMember: true } });

            const res = await DenyPost(denyReq({ processId: own.processId }));
            expect(res.status).toBe(403);
            const proc = await prisma.orgMembershipProcess.findUnique({ where: { id: own.processId } });
            expect(proc?.isPaymentPlanRequested).toBe(true); // flag NOT flipped by the refused deny

            // Drop this extra board member so it doesn't inflate the "email all board
            // members" review-team fallback that later count-based tests assert on.
            await prisma.person.delete({ where: { id: boardKin.id } });
        });

        it('a board+sysadmin may NOT deny their own household either', async () => {
            const own = await makeProc('DenySysadmin', { requested: true });
            const sysKin = await prisma.person.create({
                data: { name: 'Sys Kin', email: `sys-kin-${own.processId}-${TAG}@example.com`, isBoardMember: true, householdId: own.householdId },
            });
            mockSession.mockResolvedValue({ user: { id: sysKin.id, isBoardMember: true, isSysadmin: true } });

            const res = await DenyPost(denyReq({ processId: own.processId }));
            expect(res.status).toBe(403);
            const proc = await prisma.orgMembershipProcess.findUnique({ where: { id: own.processId } });
            expect(proc?.isPaymentPlanRequested).toBe(true); // flag NOT flipped by the refused deny

            await prisma.person.delete({ where: { id: sysKin.id } }); // keep it out of the board-member fallback set
        });
    });

    describe('POST /api/membership/request-payment-plan', () => {
        it('401 without a session', async () => {
            mockSession.mockResolvedValue(null);
            expect((await RequestPost(requestReq({ processId: leadProcessId }))).status).toBe(401);
        });

        it('400 when processId is missing', async () => {
            mockSession.mockResolvedValue({ user: { id: leadId } });
            expect((await RequestPost(requestReq({}))).status).toBe(400);
        });

        it('404 for a non-existent process', async () => {
            mockSession.mockResolvedValue({ user: { id: boardId, isBoardMember: true } });
            expect((await RequestPost(requestReq({ processId: 999999999 }))).status).toBe(404);
        });

        it('403 (IDOR) when an unrelated user requests on another household\'s membership', async () => {
            const fresh = await makeProc('IdorTarget', { requested: false, withLead: true });
            mockSession.mockResolvedValue({ user: { id: otherId } }); // not board, not this household's lead
            const res = await RequestPost(requestReq({ processId: fresh.processId }));
            expect(res.status).toBe(403);

            const proc = await prisma.orgMembershipProcess.findUnique({ where: { id: fresh.processId } });
            expect(proc?.isPaymentPlanRequested).toBe(false);
        });

        it('409 when the process is not awaiting payment', async () => {
            const bg = await makeProc('WrongPhaseReq', { requested: false, status: 'PENDING_BG_REVIEW', withLead: true });
            mockSession.mockResolvedValue({ user: { id: bg.personId } });
            const res = await RequestPost(requestReq({ processId: bg.processId }));
            expect(res.status).toBe(409);

            const proc = await prisma.orgMembershipProcess.findUnique({ where: { id: bg.processId } });
            expect(proc?.isPaymentPlanRequested).toBe(false);
        });

        it('200 when a household lead requests their own payment plan', async () => {
            const fresh = await makeProc('LeadSelfReq', { requested: false, withLead: true });
            mockSession.mockResolvedValue({ user: { id: fresh.personId } });
            const res = await RequestPost(requestReq({ processId: fresh.processId }));
            expect(res.status).toBe(200);

            const proc = await prisma.orgMembershipProcess.findUnique({ where: { id: fresh.processId } });
            expect(proc?.isPaymentPlanRequested).toBe(true);
        });

        it('200 when a board member requests on any household', async () => {
            const fresh = await makeProc('BoardReq', { requested: false, withLead: true });
            mockSession.mockResolvedValue({ user: { id: boardId, isBoardMember: true } });
            const res = await RequestPost(requestReq({ processId: fresh.processId }));
            expect(res.status).toBe(200);

            const proc = await prisma.orgMembershipProcess.findUnique({ where: { id: fresh.processId } });
            expect(proc?.isPaymentPlanRequested).toBe(true);
        });
    });

    describe('email behavior', () => {
        // Pin the review-team address so these counts are hermetic: unset, the
        // fallback emails EVERY isBoardMember row, and other suites' board
        // personas share the DB in a full CI run.
        const REVIEW_TEAM = `review-team-${TAG}@example.com`;
        let restoreBoardSettings: () => Promise<void> = async () => {};
        beforeAll(async () => {
            restoreBoardSettings = await snapshotBoardSettings();
            await prisma.boardSettings.upsert({ where: { id: 1 }, update: { scholarshipNotifyEmail: REVIEW_TEAM }, create: { id: 1, scholarshipNotifyEmail: REVIEW_TEAM } });
        });
        afterAll(async () => {
            await restoreBoardSettings();
        });
        it('a fresh request sends the review-team notify and the household ack, each once', async () => {
            const fresh = await makeProc('EmailFreshReq', { requested: false, withLead: true });
            mockSession.mockResolvedValue({ user: { id: fresh.personId } });

            const res = await RequestPost(requestReq({ processId: fresh.processId }));
            expect(res.status).toBe(200);

            const sent = __getSentEmails();
            expect(sent.filter((e) => e.subject.includes('New membership scholarship') && e.to === REVIEW_TEAM)).toHaveLength(1);
            expect(sent.filter((e) => e.subject === 'We received your scholarship / payment-plan request')).toHaveLength(1);
        });

        it('a no-op re-POST (already requested) sends zero emails', async () => {
            // leadProcessId was seeded with requested:true in beforeEach.
            mockSession.mockResolvedValue({ user: { id: leadId } });

            const res = await RequestPost(requestReq({ processId: leadProcessId }));
            expect(res.status).toBe(200);
            expect(__getSentEmails()).toHaveLength(0);
        });

        // User decision: an applicant receives EXACTLY ONE automatic *scholarship*
        // email (the request ack, covered above). Certify/approve sends NO automatic
        // scholarship-decision email — the board communicates decisions manually —
        // even though leadProcessId's household lead (a gate-worthy recipient) exists.
        // The standard activation "welcome — your membership is active" email is
        // orthogonal to the scholarship decision and IS expected here.
        it('certify (approve) sends no automatic scholarship email', async () => {
            mockSession.mockResolvedValue({ user: { id: boardId, isBoardMember: true } });

            __clearSentEmails();
            const res = await PlansPost(nextReq('http://localhost', { method: 'POST', body: JSON.stringify({ processId: leadProcessId, reason: 'Board approved scholarship' }) }));
            expect(res.status).toBe(200);

            const scholarshipEmails = __getSentEmails().filter(
                (e) => !e.subject.startsWith('Welcome to the Treehouse'),
            );
            expect(scholarshipEmails).toHaveLength(0);
        });

        // User decision: deny is deliberately silent — no automatic applicant email
        // (the request ack, covered above, is the applicant's only automatic email;
        // the board communicates a denial manually). Filtered to exclude a stray
        // "Welcome to the Treehouse" send (another test's certify/activate) rather
        // than asserting a bare zero total, so this can't be fooled by mock bleed.
        it('deny sends no automatic email', async () => {
            mockSession.mockResolvedValue({ user: { id: boardId, isBoardMember: true } });

            __clearSentEmails();
            const res = await DenyPost(denyReq({ processId: leadProcessId }));
            expect(res.status).toBe(200);

            const sent = __getSentEmails().filter((e) => !e.subject.startsWith('Welcome to the Treehouse'));
            expect(sent).toHaveLength(0);
        });

        it('a no-op re-deny (flag already false) sends zero emails', async () => {
            mockSession.mockResolvedValue({ user: { id: boardId, isBoardMember: true } });
            expect((await DenyPost(denyReq({ processId: leadProcessId }))).status).toBe(200);
            __clearSentEmails();
            const res = await DenyPost(denyReq({ processId: leadProcessId }));
            expect(res.status).toBe(409);
            expect(__getSentEmails()).toHaveLength(0);
        });

        it('deny sends no automatic email regardless of household notification settings', async () => {
            const fresh = await makeProc('DenyGate', { requested: true, withLead: true });
            await prisma.person.create({
                data: {
                    email: `deny-gate-out-${TAG}@example.com`, name: 'OptOut', householdId: fresh.householdId,
                    isHouseholdLead: true, notificationSettings: { emailScholarshipUpdates: false },
                },
            });
            mockSession.mockResolvedValue({ user: { id: boardId, isBoardMember: true } });

            __clearSentEmails();
            const res = await DenyPost(denyReq({ processId: fresh.processId }));
            expect(res.status).toBe(200);

            const sent = __getSentEmails().filter((e) => !e.subject.startsWith('Welcome to the Treehouse'));
            expect(sent).toHaveLength(0);
        });
    });

    describe('scholarship ACK settings (subject + membership body)', () => {
        let restoreBoardSettings: () => Promise<void> = async () => {};
        beforeAll(async () => {
            restoreBoardSettings = await snapshotBoardSettings();
            await prisma.boardSettings.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } });
        });
        afterAll(async () => {
            await restoreBoardSettings();
        });

        it('a configured subject + body are used for the membership ACK', async () => {
            await prisma.boardSettings.update({
                where: { id: 1 },
                data: { scholarshipAckSubject: 'Custom ACK Subject', scholarshipAckMembershipBody: 'Custom ACK body text.' },
            });
            const fresh = await makeProc('AckConfigured', { requested: false, withLead: true });
            mockSession.mockResolvedValue({ user: { id: fresh.personId } });

            const res = await RequestPost(requestReq({ processId: fresh.processId }));
            expect(res.status).toBe(200);

            const ack = __getSentEmails().find((e) => e.subject === 'Custom ACK Subject');
            expect(ack).toBeTruthy();
            expect(ack!.html).toBe('<p>Custom ACK body text.</p>');
        });

        it('unset ACK settings fall back verbatim to the default subject + body', async () => {
            await prisma.boardSettings.update({
                where: { id: 1 },
                data: { scholarshipAckSubject: null, scholarshipAckMembershipBody: null },
            });
            const fresh = await makeProc('AckDefault', { requested: false, withLead: true });
            mockSession.mockResolvedValue({ user: { id: fresh.personId } });

            const res = await RequestPost(requestReq({ processId: fresh.processId }));
            expect(res.status).toBe(200);

            const ack = __getSentEmails().find((e) => e.subject === DEFAULT_ACK_SUBJECT);
            expect(ack).toBeTruthy();
            expect(ack!.html).toBe(renderAckBody(DEFAULT_ACK_MEMBERSHIP_BODY));
        });

        it('blank/whitespace ACK settings fall back the same as unset', async () => {
            await prisma.boardSettings.update({
                where: { id: 1 },
                data: { scholarshipAckSubject: '   ', scholarshipAckMembershipBody: '\n  ' },
            });
            const fresh = await makeProc('AckBlank', { requested: false, withLead: true });
            mockSession.mockResolvedValue({ user: { id: fresh.personId } });

            const res = await RequestPost(requestReq({ processId: fresh.processId }));
            expect(res.status).toBe(200);

            const ack = __getSentEmails().find((e) => e.subject === DEFAULT_ACK_SUBJECT);
            expect(ack).toBeTruthy();
            expect(ack!.html).toBe(renderAckBody(DEFAULT_ACK_MEMBERSHIP_BODY));
        });
    });
});
