/**
 * @jest-environment node
 */
/**
 * Integration tests for the previously-untested payment-plan routes:
 *   GET  /api/finance-ops/payment-plans               (board-only queue)
 *   POST /api/finance-ops/payment-plans               (board approves → ACTIVE)
 *   POST /api/programs/[id]/request-payment-plan   (request, with IDOR guard)
 *
 * Covers auth rejections (401/403), validation (400/404), the IDOR path
 * (an unrelated authenticated user requesting on someone else's enrollment),
 * and the successful state transitions.
 */
import { GET as PlansGet, POST as PlansPost } from '@/app/api/finance-ops/payment-plans/route';
import { POST as RefusePost } from '@/app/api/finance-ops/payment-plans/refuse/route';
import { POST as ManualHoldPost } from '@/app/api/finance-ops/payment-plans/manual-hold/route';
import { POST as RequestPost } from '@/app/api/programs/[id]/request-payment-plan/route';
import { POST as ParticipantsPost, DELETE as ParticipantsDelete } from '@/app/api/programs/[id]/participants/route';
import prisma from '@/lib/prisma';
import { DEFAULT_ACK_SUBJECT, DEFAULT_ACK_PROGRAM_BODY, renderAckBody } from '@/lib/scholarshipEmails';

jest.mock('next-auth/next', () => ({
    getServerSession: jest.fn(),
}));
jest.mock('@/lib/notifications', () => ({
    sendNotification: jest.fn(),
}));
jest.mock('@/lib/email');

// eslint-disable-next-line @typescript-eslint/no-require-imports
const mockSession = require('next-auth/next').getServerSession;
// `@/lib/email`'s real module has no __getSentEmails/__clearSentEmails — those
// only exist on the manual mock (src/lib/__mocks__/email.ts) that jest.mock
// above swaps in. jest.requireMock (not a direct import) fetches that swapped
// instance so this typechecks against the mock's own shape.
const { __getSentEmails, __clearSentEmails } =
    jest.requireMock<typeof import('@/lib/__mocks__/email')>('@/lib/email');

const TAG = 'payment-plans-test';

// GET is now a security handler() and POST a withAuth() wrapper — both take a
// NextRequest. Plain Request carries the fields authenticateRequest reads.
function nextReq(url = 'http://localhost/api/finance-ops/payment-plans', init?: RequestInit) {
    return new Request(url, init) as unknown as import('next/server').NextRequest;
}

describe('Program payment-plan routes', () => {
    let programId: number;
    let mentorId: number;
    let boardId: number;
    let board2Id: number;
    let boardKinId: number;
    let selfId: number;
    let otherId: number;
    let noiseId: number;
    let memberId: number;
    const householdIds: number[] = [];

    beforeAll(async () => {
        const mentor = await prisma.person.create({
            data: { name: 'PP Mentor', email: `mentor-${TAG}@example.com`, household: { create: { name: "Test HH" } } },
        });
        mentorId = mentor.id;
        householdIds.push(mentor.householdId);

        const program = await prisma.program.create({
            data: { startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: `PP Program ${TAG}`, leadMentorId: mentorId, enrollmentStatus: 'OPEN' },
        });
        programId = program.id;

        const board = await prisma.person.create({
            data: { name: 'PP Board', email: `board-${TAG}@example.com`, isBoardMember: true, household: { create: { name: "Test HH" } } },
        });
        boardId = board.id;
        householdIds.push(board.householdId);

        // A second board member in a DIFFERENT household — the non-conflicted
        // approver, and (since #1083 gated sysadmins out of finance-ops) the
        // remedy when the first board member has a household conflict.
        const board2 = await prisma.person.create({
            data: { name: 'PP Board Two', email: `board2-${TAG}@example.com`, isBoardMember: true, household: { create: { name: "Test HH2" } } },
        });
        board2Id = board2.id;
        householdIds.push(board2.householdId);

        // A household-mate of the board member — the conflict-of-interest target.
        const boardKin = await prisma.person.create({
            data: { name: 'PP Board Kin', email: `boardkin-${TAG}@example.com`, householdId: board.householdId },
        });
        boardKinId = boardKin.id;

        const self = await prisma.person.create({
            // Adult DOB: this persona requests its OWN payment plan, and only a
            // known adult may (docs/rules/programs.md).
            data: {
                name: 'PP Self',
                email: `self-${TAG}@example.com`,
                dateOfBirth: new Date(Date.now() - (30 * 31556952000)),
                household: { create: { name: "Test HH" } },
            },
        });
        selfId = self.id;
        householdIds.push(self.householdId);

        const other = await prisma.person.create({
            // Adult DOB: this persona self-enrolls and self-requests in tests whose
            // subject is capacity / ACK copy, not the youth gate.
            data: {
                name: 'PP Other',
                email: `other-${TAG}@example.com`,
                dateOfBirth: new Date(Date.now() - (30 * 31556952000)),
                household: { create: { name: "Test HH" } },
            },
        });
        otherId = other.id;
        householdIds.push(other.householdId);

        const noise = await prisma.person.create({
            data: { name: 'PP Noise', email: `noise-${TAG}@example.com`, household: { create: { name: "Test HH" } } },
        });
        noiseId = noise.id;
        householdIds.push(noise.householdId);

        // Household with an ACTIVE org membership, for the point-in-time snapshot tests.
        const member = await prisma.person.create({
            data: { name: 'PP Member', email: `member-${TAG}@example.com`, household: { create: { name: "Member HH", orgMembership: { create: { status: 'ACTIVE' } } } } },
        });
        memberId = member.id;
        householdIds.push(member.householdId);
    });

    beforeEach(() => {
        jest.clearAllMocks();
        __clearSentEmails();
    });

    afterAll(async () => {
        await prisma.programParticipant.deleteMany({ where: { programId } });
        await prisma.program.delete({ where: { id: programId } });
        await prisma.person.deleteMany({
            where: { id: { in: [mentorId, boardId, board2Id, boardKinId, selfId, otherId, noiseId, memberId] } },
        });
        await prisma.orgMembership.deleteMany({ where: { householdId: { in: householdIds } } });
        await prisma.household.deleteMany({ where: { id: { in: householdIds } } });
    });

    // A genuine held request stamps inventoryHeldAt (that's what the apply-time -1
    // does): by default `held` follows `requested`, so enroll({requested:true}) is a
    // real PENDING_HELD row (scholarship queue). Pass held:false explicitly to seed a
    // PENDING_HOLD_FAILED row (the failed-apply state — reconciliation queue).
    async function enroll(participantId: number, opts: { requested: boolean; held?: boolean }) {
        const held = (opts.held ?? opts.requested) ? new Date() : null;
        await prisma.programParticipant.upsert({
            where: { programId_personId: { programId, personId: participantId } },
            // scholarshipRequestKind resets too: the row is reused across cases, and a
            // kind left over from a previous one would read as this request's own.
            update: { status: 'PENDING', isPaymentPlanRequested: opts.requested, pendingSince: new Date(), inventoryHeldAt: held, paymentPlanDeniedAt: null, scholarshipRequestKind: null },
            create: { programId, personId: participantId, status: 'PENDING', isPaymentPlanRequested: opts.requested, pendingSince: new Date(), inventoryHeldAt: held },
        });
    }

    // The cookie is inert except under CHECKIN_ENV=local, where the keyless-kiosk
    // fallback in authenticateRequest hijacks any cookie-less request as `kiosk`.
    function requestReq(body: unknown) {
        return new Request(`http://localhost/api/programs/${programId}/request-payment-plan`, {
            method: 'POST',
            headers: { cookie: 'session=test' },
            body: JSON.stringify(body),
        }) as unknown as import("next/server").NextRequest;
    }

    describe('GET /api/finance-ops/payment-plans', () => {
        it('401 without a session', async () => {
            mockSession.mockResolvedValue(null);
            const res = await PlansGet(nextReq());
            expect(res.status).toBe(401);
        });

        it('403 for a non-board, non-sysadmin user', async () => {
            mockSession.mockResolvedValue({ user: { id: selfId } });
            const res = await PlansGet(nextReq());
            expect(res.status).toBe(403);
        });

        it('returns only PENDING + isPaymentPlanRequested rows to a board member', async () => {
            await enroll(selfId, { requested: true });   // should appear
            await enroll(noiseId, { requested: false });  // should NOT appear
            mockSession.mockResolvedValue({ user: { id: boardId, isBoardMember: true } });

            const res = await PlansGet(nextReq());
            expect(res.status).toBe(200);
            const { ProgramParticipant: rows } = await res.json();
            const ids = rows.map((r: { personId: number }) => r.personId);
            expect(ids).toContain(selfId);
            expect(ids).not.toContain(noiseId);
        });

        it('includes each participant\'s CURRENT household org-membership status (live, for the board to decide)', async () => {
            await enroll(memberId, { requested: true });
            await enroll(selfId, { requested: true }); // selfId's household has no OrgMembership row
            mockSession.mockResolvedValue({ user: { id: boardId, isBoardMember: true } });

            const res = await PlansGet(nextReq());
            expect(res.status).toBe(200);
            const { ProgramParticipant: rows } = await res.json();
            type Row = { personId: number; person: { household?: { orgMembership?: { status: string } | null } | null } };
            const memberRow = (rows as Row[]).find(r => r.personId === memberId);
            const nonMemberRow = (rows as Row[]).find(r => r.personId === selfId);
            expect(memberRow?.person.household?.orgMembership?.status).toBe('ACTIVE');
            expect(nonMemberRow?.person.household?.orgMembership).toBeFalsy();
        });

        it('ships the next-year flag inputs: program.startAt + a BoardSettings key', async () => {
            // The flag itself is derived on the client (the stripper drops ad-hoc
            // booleans); the route's job is only to ship both inputs — the program's
            // start date and the membership-year cutoff singleton. Don't mutate the
            // BoardSettings singleton here (it's global across the integration DB);
            // just assert the key rides along and startAt round-trips.
            const startAt = new Date('2999-10-01T00:00:00Z');
            await prisma.program.update({ where: { id: programId }, data: { startAt } });
            await enroll(selfId, { requested: true });
            mockSession.mockResolvedValue({ user: { id: boardId, isBoardMember: true } });

            const res = await PlansGet(nextReq());
            expect(res.status).toBe(200);
            const body = await res.json();
            expect(body).toHaveProperty('BoardSettings');
            const row = body.ProgramParticipant.find((r: { personId: number }) => r.personId === selfId);
            expect(row.program.startAt).toBe(startAt.toISOString());
        });
    });

    describe('POST /api/finance-ops/payment-plans (approve)', () => {
        it('401 without a session', async () => {
            mockSession.mockResolvedValue(null);
            const res = await PlansPost(nextReq('http://localhost', { method: 'POST', body: '{}' }));
            expect(res.status).toBe(401);
        });

        it('403 for a non-board user', async () => {
            mockSession.mockResolvedValue({ user: { id: selfId } });
            const res = await PlansPost(nextReq('http://localhost', { method: 'POST', body: JSON.stringify({ programId, participantId: selfId }) }));
            expect(res.status).toBe(403);
        });

        it('board approval flips the enrollment to ACTIVE and clears the request flags', async () => {
            await enroll(selfId, { requested: true });
            mockSession.mockResolvedValue({ user: { id: boardId, isBoardMember: true } });

            const res = await PlansPost(nextReq('http://localhost', {
                method: 'POST',
                body: JSON.stringify({ programId, participantId: selfId }),
            }));
            expect(res.status).toBe(200);

            const row = await prisma.programParticipant.findUnique({
                where: { programId_personId: { programId, personId: selfId } },
            });
            expect(row?.status).toBe('ACTIVE');
            expect(row?.isPaymentPlanRequested).toBe(false);
            expect(row?.pendingSince).toBeNull();

            // No Shopify variant on this program — capacity propagation never engages.
            const data = await res.json();
            expect(data.warning).toBeUndefined();
        });

        // Hold-ledger (product decision 2026-07-06): the seat is decremented at
        // APPLICATION time (request-payment-plan), NOT at approval — approval
        // only stops billing the applicant and CONSUMES the hold (clears
        // inventoryHeldAt with no +1), so a later removal of this now-ACTIVE
        // comped participant must not release a seat that was never given back
        // to Shopify. Proven here by NO fetch firing at either step even though
        // the program has a variant configured.
        it('does NOT touch Shopify on approval (hold consumed, not released), and a later removal fires no +1', async () => {
            const fetchSpy = jest.spyOn(global, 'fetch');
            const shopifyProgram = await prisma.program.create({
                data: {
                    startAt: new Date('2026-01-01'),
                    endAt: new Date('2026-12-31'),
                    name: `PP Shopify Program ${TAG}`,
                    leadMentorId: mentorId,
                    enrollmentStatus: 'OPEN',
                    shopifyVariantId: 'dev-mock-variant-pp',
                },
            });
            try {
                await prisma.programParticipant.upsert({
                    where: { programId_personId: { programId: shopifyProgram.id, personId: selfId } },
                    update: { status: 'PENDING', isPaymentPlanRequested: true, pendingSince: new Date(), inventoryHeldAt: new Date() },
                    create: { programId: shopifyProgram.id, personId: selfId, status: 'PENDING', isPaymentPlanRequested: true, pendingSince: new Date(), inventoryHeldAt: new Date() },
                });
                mockSession.mockResolvedValue({ user: { id: boardId, isBoardMember: true } });

                const res = await PlansPost(nextReq('http://localhost', {
                    method: 'POST',
                    body: JSON.stringify({ programId: shopifyProgram.id, participantId: selfId }),
                }));
                expect(res.status).toBe(200);
                const data = await res.json();
                expect(data.warning).toBeUndefined();

                const row = await prisma.programParticipant.findUnique({
                    where: { programId_personId: { programId: shopifyProgram.id, personId: selfId } },
                });
                expect(row?.status).toBe('ACTIVE');
                expect(row?.inventoryHeldAt).toBeNull(); // hold consumed
                expect(fetchSpy).not.toHaveBeenCalled();

                // Later removal of the now-ACTIVE comped participant: no hold left
                // to release, so no +1 fires.
                mockSession.mockResolvedValue({ user: { id: boardId, isBoardMember: true } });
                const delRes = await ParticipantsDelete(
                    new Request(`http://localhost/api/programs/${shopifyProgram.id}/participants`, {
                        method: 'DELETE',
                        body: JSON.stringify({ participantId: selfId }),
                    }) as unknown as import('next/server').NextRequest,
                    { params: Promise.resolve({ id: String(shopifyProgram.id) }) },
                );
                expect(delRes.status).toBe(200);
                expect((await delRes.json()).warning).toBeUndefined();
                expect(fetchSpy).not.toHaveBeenCalled();
            } finally {
                fetchSpy.mockRestore();
                await prisma.programParticipant.deleteMany({ where: { programId: shopifyProgram.id } });
                await prisma.program.delete({ where: { id: shopifyProgram.id } });
            }
        });

        it('stamps wasOrgMemberAtApproval=true approving a participant from an ACTIVE-membership household', async () => {
            await enroll(memberId, { requested: true });
            mockSession.mockResolvedValue({ user: { id: boardId, isBoardMember: true } });

            const res = await PlansPost(nextReq('http://localhost', {
                method: 'POST',
                body: JSON.stringify({ programId, participantId: memberId }),
            }));
            expect(res.status).toBe(200);

            const row = await prisma.programParticipant.findUnique({
                where: { programId_personId: { programId, personId: memberId } },
            });
            expect(row?.wasOrgMemberAtApproval).toBe(true);
        });

        it('stamps wasOrgMemberAtApproval=false approving a participant from a non-member household', async () => {
            await enroll(selfId, { requested: true }); // selfId's household has no OrgMembership row
            mockSession.mockResolvedValue({ user: { id: boardId, isBoardMember: true } });

            const res = await PlansPost(nextReq('http://localhost', {
                method: 'POST',
                body: JSON.stringify({ programId, participantId: selfId }),
            }));
            expect(res.status).toBe(200);

            const row = await prisma.programParticipant.findUnique({
                where: { programId_personId: { programId, personId: selfId } },
            });
            expect(row?.wasOrgMemberAtApproval).toBe(false);
        });

        it("refuses to approve a plan for the board member's OWN household (conflict of interest); another board member is the remedy", async () => {
            await enroll(boardKinId, { requested: true });
            mockSession.mockResolvedValue({ user: { id: boardId, isBoardMember: true } });
            const res = await PlansPost(nextReq('http://localhost', {
                method: 'POST',
                body: JSON.stringify({ programId, participantId: boardKinId }),
            }));
            expect(res.status).toBe(403);
            let row = await prisma.programParticipant.findUnique({
                where: { programId_personId: { programId, personId: boardKinId } },
            });
            expect(row?.status).toBe('PENDING'); // unchanged — nothing approved

            // Sysadmins are gated out of finance-ops entirely (#1083), so they are
            // no longer the COI remedy here — a non-conflicted board member is.
            mockSession.mockResolvedValue({ user: { id: boardId, isSysadmin: true } });
            const denied = await PlansPost(nextReq('http://localhost', {
                method: 'POST',
                body: JSON.stringify({ programId, participantId: boardKinId }),
            }));
            expect(denied.status).toBe(403);
            row = await prisma.programParticipant.findUnique({
                where: { programId_personId: { programId, personId: boardKinId } },
            });
            expect(row?.status).toBe('PENDING'); // still unchanged

            // A second board member, from a different household, has no conflict.
            mockSession.mockResolvedValue({ user: { id: board2Id, isBoardMember: true } });
            const ok = await PlansPost(nextReq('http://localhost', {
                method: 'POST',
                body: JSON.stringify({ programId, participantId: boardKinId }),
            }));
            expect(ok.status).toBe(200);
            row = await prisma.programParticipant.findUnique({
                where: { programId_personId: { programId, personId: boardKinId } },
            });
            expect(row?.status).toBe('ACTIVE');
        });
    });

    describe('POST /api/programs/[id]/request-payment-plan', () => {
        const params = (id: string | number) => ({ params: Promise.resolve({ id: String(id) }) });

        it('401 without a session', async () => {
            mockSession.mockResolvedValue(null);
            const res = await RequestPost(requestReq({ participantId: selfId }), params(programId));
            expect(res.status).toBe(401);
        });

        it('400 on a non-numeric program id', async () => {
            mockSession.mockResolvedValue({ user: { id: selfId } });
            const res = await RequestPost(requestReq({ participantId: selfId }), params('abc'));
            expect(res.status).toBe(400);
        });

        it('400 when participantId is missing', async () => {
            mockSession.mockResolvedValue({ user: { id: selfId } });
            const res = await RequestPost(requestReq({}), params(programId));
            expect(res.status).toBe(400);
        });

        it('404 when the participant is not enrolled in the program', async () => {
            await prisma.programParticipant.deleteMany({ where: { programId, personId: otherId } });
            mockSession.mockResolvedValue({ user: { id: boardId, isBoardMember: true } });
            const res = await RequestPost(requestReq({ participantId: otherId }), params(programId));
            expect(res.status).toBe(404);
        });

        it('403 (IDOR) when an unrelated user requests on someone else\'s enrollment', async () => {
            await enroll(selfId, { requested: false });
            // `otherId` is just an authenticated user — not self, lead, board, or household lead.
            mockSession.mockResolvedValue({ user: { id: otherId } });
            const res = await RequestPost(requestReq({ participantId: selfId }), params(programId));
            expect(res.status).toBe(403);

            const row = await prisma.programParticipant.findUnique({
                where: { programId_personId: { programId, personId: selfId } },
            });
            expect(row?.isPaymentPlanRequested).toBe(false);
        });

        it('200 when the participant requests their own payment plan', async () => {
            await enroll(selfId, { requested: false });
            mockSession.mockResolvedValue({ user: { id: selfId } });
            const res = await RequestPost(requestReq({ participantId: selfId }), params(programId));
            expect(res.status).toBe(200);

            const row = await prisma.programParticipant.findUnique({
                where: { programId_personId: { programId, personId: selfId } },
            });
            expect(row?.isPaymentPlanRequested).toBe(true);
        });

        it('records the kind the family stated', async () => {
            await enroll(selfId, { requested: false });
            mockSession.mockResolvedValue({ user: { id: selfId } });
            const res = await RequestPost(requestReq({ participantId: selfId, kind: 'SCHOLARSHIP' }), params(programId));
            expect(res.status).toBe(200);

            const row = await prisma.programParticipant.findUnique({
                where: { programId_personId: { programId, personId: selfId } },
            });
            expect(row?.scholarshipRequestKind).toBe('SCHOLARSHIP');
        });

        it('400 on a kind that is not one of the three', async () => {
            await enroll(selfId, { requested: false });
            mockSession.mockResolvedValue({ user: { id: selfId } });
            const res = await RequestPost(requestReq({ participantId: selfId, kind: 'FREE_MONEY' }), params(programId));
            expect(res.status).toBe(400);

            const row = await prisma.programParticipant.findUnique({
                where: { programId_personId: { programId, personId: selfId } },
            });
            expect(row?.isPaymentPlanRequested).toBe(false);
        });

        it('a kind-less request still records (drain-window client), leaving the kind null', async () => {
            await enroll(selfId, { requested: false });
            mockSession.mockResolvedValue({ user: { id: selfId } });
            const res = await RequestPost(requestReq({ participantId: selfId }), params(programId));
            expect(res.status).toBe(200);

            const row = await prisma.programParticipant.findUnique({
                where: { programId_personId: { programId, personId: selfId } },
            });
            expect(row?.isPaymentPlanRequested).toBe(true);
            expect(row?.scholarshipRequestKind).toBeNull();
        });

        it('a kind-less re-POST does NOT erase a kind the family already stated', async () => {
            await enroll(selfId, { requested: false });
            mockSession.mockResolvedValue({ user: { id: selfId } });
            await RequestPost(requestReq({ participantId: selfId, kind: 'PAYMENT_PLAN' }), params(programId));
            // Same shape a stale tab mid-deploy sends: no kind at all.
            await RequestPost(requestReq({ participantId: selfId }), params(programId));

            const row = await prisma.programParticipant.findUnique({
                where: { programId_personId: { programId, personId: selfId } },
            });
            expect(row?.scholarshipRequestKind).toBe('PAYMENT_PLAN');
        });

        it('409 when the enrollment is not awaiting payment (already ACTIVE)', async () => {
            await prisma.programParticipant.upsert({
                where: { programId_personId: { programId, personId: selfId } },
                update: { status: 'ACTIVE', isPaymentPlanRequested: false },
                create: { programId, personId: selfId, status: 'ACTIVE', isPaymentPlanRequested: false },
            });
            mockSession.mockResolvedValue({ user: { id: selfId } });
            const res = await RequestPost(requestReq({ participantId: selfId }), params(programId));
            expect(res.status).toBe(409);

            const row = await prisma.programParticipant.findUnique({
                where: { programId_personId: { programId, personId: selfId } },
            });
            expect(row?.isPaymentPlanRequested).toBe(false);
        });

        // Scholarship lifecycle drives inventory (product decision 2026-07-06):
        // APPLICATION decrements Shopify by 1 — only on the false->true transition.
        describe('Shopify inventory (apply time)', () => {
            let shopifyProgramId: number;

            beforeAll(async () => {
                const p = await prisma.program.create({
                    data: { startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: `PP Apply Shopify Program ${TAG}`, enrollmentStatus: 'OPEN', shopifyVariantId: 'dev-mock-variant-apply-pp' },
                });
                shopifyProgramId = p.id;
            });

            afterAll(async () => {
                await prisma.programParticipant.deleteMany({ where: { programId: shopifyProgramId } });
                await prisma.program.delete({ where: { id: shopifyProgramId } });
            });

            it('decrements the single-pool variant by 1 on the false->true transition', async () => {
                const prevCheckinEnv = process.env.CHECKIN_ENV;
                process.env.CHECKIN_ENV = 'local';
                const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
                try {
                    await prisma.programParticipant.upsert({
                        where: { programId_personId: { programId: shopifyProgramId, personId: selfId } },
                        update: { status: 'PENDING', isPaymentPlanRequested: false, pendingSince: new Date() },
                        create: { programId: shopifyProgramId, personId: selfId, status: 'PENDING', isPaymentPlanRequested: false, pendingSince: new Date() },
                    });
                    mockSession.mockResolvedValue({ user: { id: selfId } });

                    // CHECKIN_ENV=local also arms the keyless-kiosk fallback in
                    // authenticateRequest, which hijacks any cookie-less request as
                    // `kiosk` -> 403 before the session/role gate runs — send a cookie.
                    const req = new Request(`http://localhost/api/programs/${shopifyProgramId}/request-payment-plan`, {
                        method: 'POST',
                        headers: { cookie: 'session=test' },
                        body: JSON.stringify({ participantId: selfId }),
                    }) as unknown as import('next/server').NextRequest;
                    const res = await RequestPost(req, params(shopifyProgramId));
                    expect(res.status).toBe(200);
                    const data = await res.json();
                    expect(data.warning).toBeUndefined();

                    expect(logSpy).toHaveBeenCalledWith(
                        expect.stringContaining('Would adjust inventory by -1 for variant: dev-mock-variant-apply-pp'),
                    );
                } finally {
                    logSpy.mockRestore();
                    process.env.CHECKIN_ENV = prevCheckinEnv;
                }
            });

            it('does NOT fire a second -1 on an idempotent re-request (already requested)', async () => {
                const prevCheckinEnv = process.env.CHECKIN_ENV;
                process.env.CHECKIN_ENV = 'local';
                const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
                try {
                    await prisma.programParticipant.update({
                        where: { programId_personId: { programId: shopifyProgramId, personId: selfId } },
                        data: { isPaymentPlanRequested: true },
                    });
                    mockSession.mockResolvedValue({ user: { id: selfId } });

                    const req = new Request(`http://localhost/api/programs/${shopifyProgramId}/request-payment-plan`, {
                        method: 'POST',
                        headers: { cookie: 'session=test' },
                        body: JSON.stringify({ participantId: selfId }),
                    }) as unknown as import('next/server').NextRequest;
                    const res = await RequestPost(req, params(shopifyProgramId));
                    expect(res.status).toBe(200);
                    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('Would adjust inventory'));
                } finally {
                    logSpy.mockRestore();
                    process.env.CHECKIN_ENV = prevCheckinEnv;
                }
            });
        });
    });

    describe('POST /api/finance-ops/payment-plans/refuse', () => {
        // Cookie header: harmless when CHECKIN_ENV isn't 'local', and required for
        // the tests below that DO flip it to 'local' — see the comment on the
        // approve-endpoint's Shopify test above for why (keyless-kiosk fallback).
        const refuseReq = (body: unknown) => new Request('http://localhost/api/finance-ops/payment-plans/refuse', {
            method: 'POST',
            headers: { cookie: 'session=test' },
            body: JSON.stringify(body),
        }) as unknown as import('next/server').NextRequest;

        it('401 without a session', async () => {
            mockSession.mockResolvedValue(null);
            const res = await RefusePost(refuseReq({ programId, participantId: selfId }));
            expect(res.status).toBe(401);
        });

        it('403 for a non-board user', async () => {
            mockSession.mockResolvedValue({ user: { id: selfId } });
            const res = await RefusePost(refuseReq({ programId, participantId: selfId }));
            expect(res.status).toBe(403);
        });

        it('409 when there is no pending payment-plan request', async () => {
            await enroll(otherId, { requested: false });
            mockSession.mockResolvedValue({ user: { id: boardId, isBoardMember: true } });
            const res = await RefusePost(refuseReq({ programId, participantId: otherId }));
            expect(res.status).toBe(409);
        });

        it("refuses to refuse a plan for the board member's OWN household (conflict of interest)", async () => {
            await enroll(boardKinId, { requested: true });
            mockSession.mockResolvedValue({ user: { id: boardId, isBoardMember: true } });
            const res = await RefusePost(refuseReq({ programId, participantId: boardKinId }));
            expect(res.status).toBe(403);

            const row = await prisma.programParticipant.findUnique({
                where: { programId_personId: { programId, personId: boardKinId } },
            });
            expect(row?.isPaymentPlanRequested).toBe(true); // unchanged
        });

        it('denies a pending request: no Shopify op, hold persists, denial stamped', async () => {
            const fetchSpy = jest.spyOn(global, 'fetch');
            const shopifyProgram = await prisma.program.create({
                data: { startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: `PP Refuse Shopify Program ${TAG}`, enrollmentStatus: 'OPEN', shopifyVariantId: 'dev-mock-variant-refuse-pp' },
            });
            try {
                // inventoryHeldAt set, as APPLICATION would have stamped it.
                await prisma.programParticipant.upsert({
                    where: { programId_personId: { programId: shopifyProgram.id, personId: selfId } },
                    update: { status: 'PENDING', isPaymentPlanRequested: true, pendingSince: new Date(), inventoryHeldAt: new Date() },
                    create: { programId: shopifyProgram.id, personId: selfId, status: 'PENDING', isPaymentPlanRequested: true, pendingSince: new Date(), inventoryHeldAt: new Date() },
                });
                mockSession.mockResolvedValue({ user: { id: boardId, isBoardMember: true } });

                const res = await RefusePost(refuseReq({ programId: shopifyProgram.id, participantId: selfId }));
                expect(res.status).toBe(200);
                expect((await res.json()).warning).toBeUndefined();

                const row = await prisma.programParticipant.findUnique({
                    where: { programId_personId: { programId: shopifyProgram.id, personId: selfId } },
                });
                expect(row?.isPaymentPlanRequested).toBe(false);
                expect(row?.status).toBe('PENDING'); // still holds the enrollment
                expect(row?.inventoryHeldAt).not.toBeNull(); // hold persists — no +1
                expect(row?.paymentPlanDeniedAt).not.toBeNull(); // denial stamped

                const audit = await prisma.auditLog.findFirst({
                    where: { actorId: boardId, tableName: 'ProgramParticipant', affectedEntityId: selfId, secondaryAffectedEntity: shopifyProgram.id, action: 'EDIT' },
                });
                expect(audit).not.toBeNull();

                expect(fetchSpy).not.toHaveBeenCalled(); // no Shopify op at all — this supersedes the earlier deny-time +1

                // Double-refuse: the second call finds isPaymentPlanRequested
                // already false -> 409, no-op.
                const second = await RefusePost(refuseReq({ programId: shopifyProgram.id, participantId: selfId }));
                expect(second.status).toBe(409);
                expect(fetchSpy).not.toHaveBeenCalled();
            } finally {
                fetchSpy.mockRestore();
                await prisma.programParticipant.deleteMany({ where: { programId: shopifyProgram.id } });
                await prisma.program.delete({ where: { id: shopifyProgram.id } });
            }
        });

        it('re-applies while holding after a denial: no second -1, denial stamp clears', async () => {
            const prevCheckinEnv = process.env.CHECKIN_ENV;
            process.env.CHECKIN_ENV = 'local';
            const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
            const shopifyProgram = await prisma.program.create({
                data: { startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: `PP Reapply Shopify Program ${TAG}`, enrollmentStatus: 'OPEN', shopifyVariantId: 'dev-mock-variant-reapply-pp' },
            });
            const reqParams = (id: string | number) => ({ params: Promise.resolve({ id: String(id) }) });
            try {
                await prisma.programParticipant.upsert({
                    where: { programId_personId: { programId: shopifyProgram.id, personId: selfId } },
                    update: { status: 'PENDING', isPaymentPlanRequested: true, pendingSince: new Date(), inventoryHeldAt: new Date() },
                    create: { programId: shopifyProgram.id, personId: selfId, status: 'PENDING', isPaymentPlanRequested: true, pendingSince: new Date(), inventoryHeldAt: new Date() },
                });

                // Deny -> no Shopify op, hold persists, deniedAt stamped.
                mockSession.mockResolvedValue({ user: { id: boardId, isBoardMember: true } });
                const refuseRes = await RefusePost(refuseReq({ programId: shopifyProgram.id, participantId: selfId }));
                expect(refuseRes.status).toBe(200);
                expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('Would adjust inventory'));

                let row = await prisma.programParticipant.findUnique({
                    where: { programId_personId: { programId: shopifyProgram.id, personId: selfId } },
                });
                expect(row?.inventoryHeldAt).not.toBeNull();
                expect(row?.paymentPlanDeniedAt).not.toBeNull();

                // Re-apply while still holding -> flips the request flag + clears the
                // denial stamp, but does NOT fire a second -1 (inventoryHeldAt was
                // already set, so the apply-time guard's branch-1 never runs).
                logSpy.mockClear();
                mockSession.mockResolvedValue({ user: { id: selfId } });
                const reapplyRes = await RequestPost(
                    new Request(`http://localhost/api/programs/${shopifyProgram.id}/request-payment-plan`, {
                        method: 'POST',
                        headers: { cookie: 'session=test' },
                        body: JSON.stringify({ participantId: selfId }),
                    }) as unknown as import('next/server').NextRequest,
                    reqParams(shopifyProgram.id),
                );
                expect(reapplyRes.status).toBe(200);
                expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('Would adjust inventory'));

                row = await prisma.programParticipant.findUnique({
                    where: { programId_personId: { programId: shopifyProgram.id, personId: selfId } },
                });
                expect(row?.isPaymentPlanRequested).toBe(true);
                expect(row?.paymentPlanDeniedAt).toBeNull(); // denial stamp cleared
                expect(row?.inventoryHeldAt).not.toBeNull(); // still held throughout
            } finally {
                logSpy.mockRestore();
                process.env.CHECKIN_ENV = prevCheckinEnv;
                await prisma.programParticipant.deleteMany({ where: { programId: shopifyProgram.id } });
                await prisma.program.delete({ where: { id: shopifyProgram.id } });
            }
        });
    });

    describe('Composed: scholarship holds a capacity seat with no Shopify involvement', () => {
        it('enroll (PENDING) -> request plan -> board approves -> ACTIVE, seat held, no fetch fires', async () => {
            // A priced program needs a variant (an unsellable one is refused at
            // enrollment), and the hold's -1 goes through the local mock — so the
            // whole journey still fires no Shopify HTTP call.
            const scholarshipProgram = await prisma.program.create({
                data: {
                    startAt: new Date('2026-01-01'),
                    endAt: new Date('2026-12-31'),
                    name: `PP Scholarship Program ${TAG}`,
                    enrollmentStatus: 'OPEN',
                    maxParticipants: 1,
                    orgMemberPriceCents: 1000,
                    nonOrgMemberPriceCents: 1500,
                    shopifyVariantId: `dev-mock-variant-scholarship-${TAG}`,
                },
            });

            const fetchSpy = jest.spyOn(global, 'fetch');
            const prevCheckinEnv = process.env.CHECKIN_ENV;
            process.env.CHECKIN_ENV = 'local';

            try {
                // 1. Participant enrolls — paid program, so lands PENDING and
                // occupies the single capacity slot (capacity counts ALL statuses).
                mockSession.mockResolvedValue({ user: { id: selfId } });
                const enrollRes = await ParticipantsPost(
                    new Request(`http://localhost/api/programs/${scholarshipProgram.id}/participants`, {
                        method: 'POST',
                        headers: { cookie: 'session=test' },
                        body: JSON.stringify({ participantId: selfId }),
                    }) as unknown as import('next/server').NextRequest,
                    { params: Promise.resolve({ id: String(scholarshipProgram.id) }) },
                );
                expect(enrollRes.status).toBe(200);
                expect((await enrollRes.json()).enrollment.status).toBe('PENDING');

                // 2. Participant requests a scholarship / payment plan.
                const requestRes = await RequestPost(
                    requestReq({ participantId: selfId }),
                    { params: Promise.resolve({ id: String(scholarshipProgram.id) }) },
                );
                expect(requestRes.status).toBe(200);

                // 3. Board approves via finance-ops — no Shopify checkout involved.
                mockSession.mockResolvedValue({ user: { id: boardId, isBoardMember: true } });
                const approveRes = await PlansPost(
                    new Request('http://localhost', {
                        method: 'POST',
                        headers: { cookie: 'session=test' },
                        body: JSON.stringify({ programId: scholarshipProgram.id, participantId: selfId }),
                    }) as unknown as import('next/server').NextRequest,
                );
                expect(approveRes.status).toBe(200);

                const row = await prisma.programParticipant.findUnique({
                    where: { programId_personId: { programId: scholarshipProgram.id, personId: selfId } },
                });
                expect(row?.status).toBe('ACTIVE');
                expect(fetchSpy).not.toHaveBeenCalled();

                // 4. Capacity still holds: a second enrollee is rejected while the
                // scholarship seat counts against maxParticipants.
                mockSession.mockResolvedValue({ user: { id: otherId } });
                const secondRes = await ParticipantsPost(
                    new Request(`http://localhost/api/programs/${scholarshipProgram.id}/participants`, {
                        method: 'POST',
                        headers: { cookie: 'session=test' },
                        body: JSON.stringify({ participantId: otherId }),
                    }) as unknown as import('next/server').NextRequest,
                    { params: Promise.resolve({ id: String(scholarshipProgram.id) }) },
                );
                expect(secondRes.status).toBe(400);
                expect((await secondRes.json()).error).toMatch(/maximum capacity/);
            } finally {
                fetchSpy.mockRestore();
                process.env.CHECKIN_ENV = prevCheckinEnv;
                await prisma.programParticipant.deleteMany({ where: { programId: scholarshipProgram.id } });
                await prisma.program.delete({ where: { id: scholarshipProgram.id } });
            }
        });
    });

    // Scholarship state is board/finance-confidential: a program's volunteer lead
    // mentor must neither initiate a request nor read the hardship fields
    // (paymentPlanDeniedAt / inventoryHeldAt) off any response; and a failed
    // Shopify -1 must not leave a phantom hold behind.
    describe('confidentiality + failed-hold rollback', () => {
        const params = (id: string | number) => ({ params: Promise.resolve({ id: String(id) }) });

        it('403 when the program lead mentor requests a payment plan for a participant', async () => {
            await enroll(otherId, { requested: false });
            mockSession.mockResolvedValue({ user: { id: mentorId } });
            const res = await RequestPost(requestReq({ participantId: otherId }), params(programId));
            expect(res.status).toBe(403);
        });

        it('request and DELETE responses carry no raw participant row (no hardship fields)', async () => {
            await enroll(selfId, { requested: false });
            mockSession.mockResolvedValue({ user: { id: selfId } });

            const reqRes = await RequestPost(requestReq({ participantId: selfId }), params(programId));
            expect(reqRes.status).toBe(200);
            const reqBody = await reqRes.json();
            expect(reqBody.success).toBe(true);
            expect(reqBody.participant).toBeUndefined();

            const delRes = await ParticipantsDelete(
                new Request(`http://localhost/api/programs/${programId}/participants`, {
                    method: 'DELETE',
                    body: JSON.stringify({ participantId: selfId }),
                }) as unknown as import('next/server').NextRequest,
                params(programId),
            );
            expect(delRes.status).toBe(200);
            const delBody = await delRes.json();
            expect(delBody.success).toBe(true);
            expect(delBody.enrollment).toBeUndefined();
        });

        it('a failed Shopify -1 leaves a clean PENDING_HOLD_FAILED row and reassures the applicant', async () => {
            // Default env: shopifyMockActive() is false and no credentials are
            // configured, so adjustProgramInventory returns false without throwing.
            const p = await prisma.program.create({
                data: { startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: `PP Rollback Shopify Program ${TAG}`, enrollmentStatus: 'OPEN', shopifyVariantId: 'dev-mock-variant-rollback-pp' },
            });
            try {
                await prisma.programParticipant.create({
                    data: { programId: p.id, personId: selfId, status: 'PENDING', isPaymentPlanRequested: false, pendingSince: new Date() },
                });
                mockSession.mockResolvedValue({ user: { id: selfId } });

                const res = await RequestPost(
                    new Request(`http://localhost/api/programs/${p.id}/request-payment-plan`, {
                        method: 'POST',
                        body: JSON.stringify({ participantId: selfId }),
                    }) as unknown as import('next/server').NextRequest,
                    params(p.id),
                );
                expect(res.status).toBe(200);
                // No "re-submit to retry": the request stands, the board finalizes it.
                const body = await res.json();
                expect(body.warning).toMatch(/board/i);
                expect(body.warning).not.toMatch(/re-submit|retry|rolled back/i);

                // Shopify-failure branch: the ack still fires, carrying the warning
                // copy instead of the normal ack body, and the review-team notify
                // still fires (a request was still recorded, board still needs it).
                const sent = __getSentEmails();
                const ack = sent.find((e) => e.to === `self-${TAG}@example.com`);
                expect(ack?.html).toContain(body.warning);
                expect(sent.some((e) => e.subject.startsWith('New scholarship / payment-plan request'))).toBe(true);

                // The exact PENDING_HOLD_FAILED tuple: PENDING, held=null, req=true, den=null.
                const row = await prisma.programParticipant.findUniqueOrThrow({
                    where: { programId_personId: { programId: p.id, personId: selfId } },
                });
                expect(row.status).toBe('PENDING');
                expect(row.inventoryHeldAt).toBeNull(); // no phantom hold
                expect(row.isPaymentPlanRequested).toBe(true); // request still stands
                expect(row.paymentPlanDeniedAt).toBeNull();
            } finally {
                await prisma.programParticipant.deleteMany({ where: { programId: p.id } });
                await prisma.program.delete({ where: { id: p.id } });
            }
        });
    });

    // The PENDING_HOLD_FAILED model: hold-failed rows (req=true, held=null) are a
    // distinct state served by a SEPARATE board queue, resolved by manual-hold, and
    // approvable/deniable only as a deliberate override.
    describe('PENDING_HOLD_FAILED — two queues, manual-hold, override', () => {
        const holdReq = (body: unknown) => new Request('http://localhost/api/finance-ops/payment-plans/manual-hold', {
            method: 'POST',
            headers: { cookie: 'session=test' },
            body: JSON.stringify(body),
        }) as unknown as import('next/server').NextRequest;

        it('the two queues return DISJOINT sets: scholarship = held, reconciliation = hold-failed', async () => {
            await enroll(selfId, { requested: true, held: true });    // PENDING_HELD → scholarship queue
            await enroll(otherId, { requested: true, held: false });  // PENDING_HOLD_FAILED → reconciliation queue
            mockSession.mockResolvedValue({ user: { id: boardId, isBoardMember: true } });

            const scholarship = await (await PlansGet(nextReq())).json();
            const holds = await (await PlansGet(nextReq('http://localhost/api/finance-ops/payment-plans?queue=holds'))).json();
            const sIds = scholarship.ProgramParticipant.map((r: { personId: number }) => r.personId);
            const hIds = holds.ProgramParticipant.map((r: { personId: number }) => r.personId);

            expect(sIds).toContain(selfId);
            expect(sIds).not.toContain(otherId);
            expect(hIds).toContain(otherId);
            expect(hIds).not.toContain(selfId);
        });

        it('manual-hold stamps inventoryHeldAt, moving PENDING_HOLD_FAILED → PENDING_HELD (no Shopify call)', async () => {
            const fetchSpy = jest.spyOn(global, 'fetch');
            try {
                await enroll(selfId, { requested: true, held: false }); // PENDING_HOLD_FAILED
                mockSession.mockResolvedValue({ user: { id: boardId, isBoardMember: true } });

                const res = await ManualHoldPost(holdReq({ programId, participantId: selfId }));
                expect(res.status).toBe(200);
                expect(fetchSpy).not.toHaveBeenCalled(); // human removed the seat by hand; route touches no Shopify

                const row = await prisma.programParticipant.findUniqueOrThrow({
                    where: { programId_personId: { programId, personId: selfId } },
                });
                expect(row.inventoryHeldAt).not.toBeNull(); // now PENDING_HELD
                expect(row.isPaymentPlanRequested).toBe(true);
                expect(row.status).toBe('PENDING');

                // The row now appears in the scholarship queue and no longer in the reconciliation queue.
                const scholarship = await (await PlansGet(nextReq())).json();
                expect(scholarship.ProgramParticipant.map((r: { personId: number }) => r.personId)).toContain(selfId);

                // Second manual-hold is a no-op 409 (already held).
                const second = await ManualHoldPost(holdReq({ programId, participantId: selfId }));
                expect(second.status).toBe(409);
            } finally {
                fetchSpy.mockRestore();
            }
        });

        it('manual-hold 409s on a genuine held request (nothing to reconcile)', async () => {
            await enroll(selfId, { requested: true, held: true }); // already PENDING_HELD
            mockSession.mockResolvedValue({ user: { id: boardId, isBoardMember: true } });
            const res = await ManualHoldPost(holdReq({ programId, participantId: selfId }));
            expect(res.status).toBe(409);
        });

        it('401 without a session calling manual-hold', async () => {
            mockSession.mockResolvedValue(null);
            const res = await ManualHoldPost(holdReq({ programId, participantId: selfId }));
            expect(res.status).toBe(401);
        });

        it('403 for a non-board user calling manual-hold', async () => {
            mockSession.mockResolvedValue({ user: { id: selfId } });
            const res = await ManualHoldPost(holdReq({ programId, participantId: selfId }));
            expect(res.status).toBe(403);
        });

        it('approve override works on a hold-failed row (phantom comp — the gated path)', async () => {
            await enroll(selfId, { requested: true, held: false }); // PENDING_HOLD_FAILED
            mockSession.mockResolvedValue({ user: { id: boardId, isBoardMember: true } });
            const res = await PlansPost(nextReq('http://localhost', {
                method: 'POST',
                body: JSON.stringify({ programId, participantId: selfId }),
            }));
            expect(res.status).toBe(200);
            const row = await prisma.programParticipant.findUniqueOrThrow({
                where: { programId_personId: { programId, personId: selfId } },
            });
            expect(row.status).toBe('ACTIVE');
            expect(row.isPaymentPlanRequested).toBe(false);
        });

        it('deny override works on a hold-failed row', async () => {
            await enroll(selfId, { requested: true, held: false }); // PENDING_HOLD_FAILED
            mockSession.mockResolvedValue({ user: { id: boardId, isBoardMember: true } });
            const res = await RefusePost(new Request('http://localhost/api/finance-ops/payment-plans/refuse', {
                method: 'POST',
                headers: { cookie: 'session=test' },
                body: JSON.stringify({ programId, participantId: selfId }),
            }) as unknown as import('next/server').NextRequest);
            expect(res.status).toBe(200);
            const row = await prisma.programParticipant.findUniqueOrThrow({
                where: { programId_personId: { programId, personId: selfId } },
            });
            expect(row.status).toBe('PENDING');
            expect(row.isPaymentPlanRequested).toBe(false);
            expect(row.paymentPlanDeniedAt).not.toBeNull();
        });
    });

    // scholarshipNotifyEmail is unset throughout this file, so notifyReviewTeam
    // always falls back to emailBoardMembers — which finds exactly {boardId,
    // board2Id} (the only two isBoardMember:true rows this suite ever creates).
    describe('email behavior', () => {
        const REVIEW_TEAM_EMAILS = [`board-${TAG}@example.com`, `board2-${TAG}@example.com`].sort();
        let emailProgramId: number;
        const createdPersonIds: number[] = [];
        const createdHouseholdIds: number[] = [];

        const params = (id: string | number) => ({ params: Promise.resolve({ id: String(id) }) });
        const refuseReq = (body: unknown) => new Request('http://localhost/api/finance-ops/payment-plans/refuse', {
            method: 'POST',
            body: JSON.stringify(body),
        }) as unknown as import('next/server').NextRequest;

        async function makeHousehold(label: string): Promise<number> {
            const hh = await prisma.household.create({ data: { name: `Email ${label} ${TAG}` } });
            createdHouseholdIds.push(hh.id);
            return hh.id;
        }
        async function makePerson(
            label: string,
            householdId: number,
            opts: { isHouseholdLead?: boolean } = {},
        ): Promise<{ id: number; email: string }> {
            const email = `email-${label}-${TAG}@example.com`;
            const p = await prisma.person.create({
                data: {
                    name: `Email ${label}`,
                    email,
                    householdId,
                    // Adult DOB: these personas request their own payment plans.
                    dateOfBirth: new Date(Date.now() - (30 * 31556952000)),
                    isHouseholdLead: opts.isHouseholdLead ?? false,
                },
            });
            createdPersonIds.push(p.id);
            return { id: p.id, email };
        }

        let prevNotify: string | null = null;
        beforeAll(async () => {
            const p = await prisma.program.create({
                data: { startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: `PP Email Behavior Program ${TAG}`, enrollmentStatus: 'OPEN' },
            });
            emailProgramId = p.id;
            // Pin the review-team address list so the exact-recipients assertions are
            // hermetic: unset, the fallback emails EVERY isBoardMember row, and other
            // suites' board personas share the DB in a full CI run.
            const settings = await prisma.boardSettings.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } });
            prevNotify = settings.scholarshipNotifyEmail;
            await prisma.boardSettings.update({ where: { id: 1 }, data: { scholarshipNotifyEmail: REVIEW_TEAM_EMAILS.join(', ') } });
        });

        afterAll(async () => {
            await prisma.boardSettings.update({ where: { id: 1 }, data: { scholarshipNotifyEmail: prevNotify } });
            await prisma.programParticipant.deleteMany({ where: { programId: emailProgramId } });
            await prisma.person.deleteMany({ where: { id: { in: createdPersonIds } } });
            await prisma.household.deleteMany({ where: { id: { in: createdHouseholdIds } } });
            await prisma.program.delete({ where: { id: emailProgramId } });
        });

        it('a fresh request (PENDING_UNPAID → HELD) sends the review-team notify and the household ack, each once', async () => {
            const householdId = await makeHousehold('fresh');
            const participant = await makePerson('fresh-participant', householdId);
            await prisma.programParticipant.create({
                data: { programId: emailProgramId, personId: participant.id, status: 'PENDING', isPaymentPlanRequested: false, pendingSince: new Date() },
            });
            mockSession.mockResolvedValue({ user: { id: participant.id } });

            const res = await RequestPost(requestReq({ participantId: participant.id }), params(emailProgramId));
            expect(res.status).toBe(200);

            const sent = __getSentEmails();
            const review = sent.filter((e) => e.subject.startsWith('New scholarship / payment-plan request'));
            expect(review.map((e) => e.to).sort()).toEqual(REVIEW_TEAM_EMAILS);
            const ack = sent.filter((e) => e.subject === 'We received your scholarship / payment-plan request');
            expect(ack).toEqual([expect.objectContaining({ to: participant.email })]);
        });

        it('a no-op re-POST (already PENDING_HELD) sends zero emails', async () => {
            const householdId = await makeHousehold('noop');
            const participant = await makePerson('noop-participant', householdId);
            await prisma.programParticipant.create({
                data: { programId: emailProgramId, personId: participant.id, status: 'PENDING', isPaymentPlanRequested: true, pendingSince: new Date(), inventoryHeldAt: new Date() },
            });
            mockSession.mockResolvedValue({ user: { id: participant.id } });

            const res = await RequestPost(requestReq({ participantId: participant.id }), params(emailProgramId));
            expect(res.status).toBe(200);
            expect(__getSentEmails()).toHaveLength(0);
        });

        it('a re-request after denial (PENDING_HELD_DENIED → HELD) sends the review-team notify and the household ack', async () => {
            const householdId = await makeHousehold('redeny');
            const participant = await makePerson('redeny-participant', householdId);
            await prisma.programParticipant.create({
                data: {
                    programId: emailProgramId, personId: participant.id, status: 'PENDING',
                    isPaymentPlanRequested: false, pendingSince: new Date(),
                    inventoryHeldAt: new Date(), paymentPlanDeniedAt: new Date(),
                },
            });
            mockSession.mockResolvedValue({ user: { id: participant.id } });

            const res = await RequestPost(requestReq({ participantId: participant.id }), params(emailProgramId));
            expect(res.status).toBe(200);

            const sent = __getSentEmails();
            expect(sent.filter((e) => e.subject.startsWith('New scholarship / payment-plan request'))).toHaveLength(REVIEW_TEAM_EMAILS.length);
            expect(sent.filter((e) => e.subject === 'We received your scholarship / payment-plan request')).toHaveLength(1);
        });

        // User decision: an applicant receives EXACTLY ONE automatic email (the
        // request ack, covered above). Approve and deny send NO automatic email —
        // the board communicates decisions manually — even though a household lead
        // (a plausible recipient) exists on the household.
        it('approve sends no automatic email', async () => {
            const householdId = await makeHousehold('approve');
            await makePerson('approve-lead', householdId, { isHouseholdLead: true });
            const participant = await makePerson('approve-participant', householdId);
            await prisma.programParticipant.create({
                data: { programId: emailProgramId, personId: participant.id, status: 'PENDING', isPaymentPlanRequested: true, pendingSince: new Date(), inventoryHeldAt: new Date() },
            });
            mockSession.mockResolvedValue({ user: { id: boardId, isBoardMember: true } });

            __clearSentEmails();
            const res = await PlansPost(nextReq('http://localhost', {
                method: 'POST',
                body: JSON.stringify({ programId: emailProgramId, participantId: participant.id }),
            }));
            expect(res.status).toBe(200);

            expect(__getSentEmails()).toHaveLength(0);
        });

        it('deny sends no automatic email (the grace-expiry clock, if configured, now starts silently)', async () => {
            const householdId = await makeHousehold('deny');
            await makePerson('deny-lead', householdId, { isHouseholdLead: true });
            const participant = await makePerson('deny-participant', householdId);
            await prisma.programParticipant.create({
                data: { programId: emailProgramId, personId: participant.id, status: 'PENDING', isPaymentPlanRequested: true, pendingSince: new Date(), inventoryHeldAt: new Date() },
            });
            mockSession.mockResolvedValue({ user: { id: boardId, isBoardMember: true } });

            __clearSentEmails();
            const res = await RefusePost(refuseReq({ programId: emailProgramId, participantId: participant.id }));
            expect(res.status).toBe(200);

            expect(__getSentEmails()).toHaveLength(0);
        });
    });

    describe('scholarship ACK settings (subject + program body)', () => {
        const params = (id: string | number) => ({ params: Promise.resolve({ id: String(id) }) });
        const PROGRAM_NAME = `PP Program ${TAG}`; // == the name programId was created with, in beforeAll
        let prevAck: { scholarshipAckSubject: string | null; scholarshipAckProgramBody: string | null } | null = null;

        beforeAll(async () => {
            const s = await prisma.boardSettings.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } });
            prevAck = { scholarshipAckSubject: s.scholarshipAckSubject, scholarshipAckProgramBody: s.scholarshipAckProgramBody };
        });
        afterAll(async () => {
            await prisma.boardSettings.update({ where: { id: 1 }, data: prevAck! });
        });

        it('a configured subject + body (with {{programName}}) are used for the program ACK', async () => {
            await prisma.boardSettings.update({
                where: { id: 1 },
                data: { scholarshipAckSubject: 'Custom Program ACK Subject', scholarshipAckProgramBody: 'Thanks for applying to {{programName}}!' },
            });
            await enroll(selfId, { requested: false });
            mockSession.mockResolvedValue({ user: { id: selfId } });

            const res = await RequestPost(requestReq({ participantId: selfId }), params(programId));
            expect(res.status).toBe(200);

            const ack = __getSentEmails().find((e) => e.subject === 'Custom Program ACK Subject');
            expect(ack).toBeTruthy();
            expect(ack!.html).toBe(`<p>Thanks for applying to ${PROGRAM_NAME}!</p>`);
        });

        it('unset ACK settings fall back verbatim to the default subject + program body', async () => {
            await prisma.boardSettings.update({
                where: { id: 1 },
                data: { scholarshipAckSubject: null, scholarshipAckProgramBody: null },
            });
            await enroll(otherId, { requested: false });
            mockSession.mockResolvedValue({ user: { id: otherId } });

            const res = await RequestPost(requestReq({ participantId: otherId }), params(programId));
            expect(res.status).toBe(200);

            const ack = __getSentEmails().find((e) => e.subject === DEFAULT_ACK_SUBJECT);
            expect(ack).toBeTruthy();
            expect(ack!.html).toBe(renderAckBody(DEFAULT_ACK_PROGRAM_BODY, { programName: PROGRAM_NAME }));
        });

        it('Shopify-failure branch: configured subject applies, but the body stays the hard-coded warning copy (ignores the configured program template)', async () => {
            await prisma.boardSettings.update({
                where: { id: 1 },
                data: {
                    scholarshipAckSubject: 'Custom Failure Subject',
                    scholarshipAckProgramBody: 'This configured template must NOT appear in the failure-branch email.',
                },
            });
            const p = await prisma.program.create({
                data: { startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: `PP Ack Rollback Shopify Program ${TAG}`, enrollmentStatus: 'OPEN', shopifyVariantId: 'dev-mock-variant-ack-rollback-pp' },
            });
            try {
                await prisma.programParticipant.create({
                    data: { programId: p.id, personId: selfId, status: 'PENDING', isPaymentPlanRequested: false, pendingSince: new Date() },
                });
                mockSession.mockResolvedValue({ user: { id: selfId } });

                const res = await RequestPost(
                    new Request(`http://localhost/api/programs/${p.id}/request-payment-plan`, {
                        method: 'POST',
                        body: JSON.stringify({ participantId: selfId }),
                    }) as unknown as import('next/server').NextRequest,
                    params(p.id),
                );
                expect(res.status).toBe(200);
                const body = await res.json();
                expect(body.warning).toMatch(/board/i); // the hard-coded operational-incident copy

                const ack = __getSentEmails().find((e) => e.subject === 'Custom Failure Subject');
                expect(ack).toBeTruthy();
                expect(ack!.html).toBe(`<p>${body.warning}</p>`); // escapeHtml no-ops here — the warning has no special chars
                expect(ack!.html).not.toContain('This configured template must NOT appear');
            } finally {
                await prisma.programParticipant.deleteMany({ where: { programId: p.id } });
                await prisma.program.delete({ where: { id: p.id } });
            }
        });
    });
});
