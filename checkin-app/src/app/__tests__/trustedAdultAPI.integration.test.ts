/**
 * @jest-environment node
 */
/**
 * Integration tests for the Trusted Adults API: household-scoped disclosure, the
 * board-only decision gate (approve needs a shared note), the household "mine"
 * view, and — the heart of the feature — the operational view where keyholders
 * (global) and program leads see the board's shared note but NEVER the family's
 * board-facing context.
 */

import { POST as CREATE } from '@/app/api/trusted-adults/route';
import { GET as MINE } from '@/app/api/trusted-adults/mine/route';
import { GET as OPERATIONAL } from '@/app/api/trusted-adults/operational/route';
import { POST as DECISION } from '@/app/api/safety/trusted-adults/decision/route';
import { POST as OVERRIDE } from '@/app/api/safety/trusted-adults/override/route';
import prisma from '@/lib/prisma';
import { runExpirySweep } from '@/lib/trusted-adult/service';
import { getServerSession } from 'next-auth/next';
import { expectAuditRow, auditJson } from '@/test-helpers/expectAuditRow';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));
jest.mock('@/lib/email', () => ({
    sendEmail: jest.fn().mockResolvedValue(true),
    runPaced: (tasks: Array<() => Promise<unknown>>) => Promise.all(tasks.map((t) => t())),
}));

const TAG = 'trustedadult-api-test';
const SHARED = 'Grandma may pick up the kids.';

function as(id: number, householdId: number, roles: { isBoardMember?: boolean; isSysadmin?: boolean; isKeyholder?: boolean } = {}) {
    (getServerSession as jest.Mock).mockResolvedValue({
        user: { id, householdId, isSysadmin: false, isBoardMember: false, isKeyholder: false, isBackgroundCheckReviewer: false, ...roles },
    });
}
function post(url: string, body: unknown) {
    return new Request(`http://localhost:4000${url}`, { method: 'POST', body: JSON.stringify(body) }) as never;
}
function get(url: string) {
    return new Request(`http://localhost:4000${url}`) as never;
}

describe('Trusted Adults API', () => {
    let familyHh = 0, leadId = 0, childId = 0;
    let boardId = 0, boardHh = 0;
    let keyholderId = 0, keyholderHh = 0;
    let programLeadId = 0, programLeadHh = 0;
    let outsiderId = 0, outsiderHh = 0;
    let programId = 0;

    async function wipe() {
        const hhs = await prisma.household.findMany({ where: { name: { contains: TAG } }, select: { id: true } });
        const ids = hhs.map((h) => h.id);
        if (ids.length) {
            await prisma.trustedAdultReview.deleteMany({ where: { householdId: { in: ids } } });
            await prisma.trustedAdult.deleteMany({ where: { householdId: { in: ids } } });
            const parts = await prisma.person.findMany({ where: { householdId: { in: ids } }, select: { id: true } });
            const pids = parts.map((p) => p.id);
            await prisma.programParticipant.deleteMany({ where: { personId: { in: pids } } });
            await prisma.program.deleteMany({ where: { name: { contains: TAG } } });
            await prisma.person.deleteMany({ where: { householdId: { in: ids } } });
        }
        await prisma.household.deleteMany({ where: { id: { in: ids } } });
    }

    beforeAll(async () => {
        await wipe();
        const fhh = await prisma.household.create({ data: { name: `Family HH ${TAG}` } });
        familyHh = fhh.id;
        leadId = (await prisma.person.create({ data: { name: 'Lead', householdId: familyHh } })).id;
        await prisma.person.update({ where: { id: leadId }, data: { isHouseholdLead: true } });
        childId = (await prisma.person.create({ data: { name: 'Child', householdId: familyHh } })).id;

        boardHh = (await prisma.household.create({ data: { name: `Board HH ${TAG}` } })).id;
        boardId = (await prisma.person.create({ data: { name: 'Board', isBoardMember: true, householdId: boardHh } })).id;
        keyholderHh = (await prisma.household.create({ data: { name: `Key HH ${TAG}` } })).id;
        keyholderId = (await prisma.person.create({ data: { name: 'Key', isKeyholder: true, householdId: keyholderHh } })).id;
        programLeadHh = (await prisma.household.create({ data: { name: `PL HH ${TAG}` } })).id;
        programLeadId = (await prisma.person.create({ data: { name: 'PL', householdId: programLeadHh } })).id;
        outsiderHh = (await prisma.household.create({ data: { name: `Out HH ${TAG}` } })).id;
        outsiderId = (await prisma.person.create({ data: { name: 'Out', householdId: outsiderHh } })).id;

        // Program led by programLeadId with the family's child enrolled.
        const prog = await prisma.program.create({ data: { startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: `Prog ${TAG}`, leadMentorId: programLeadId } });
        programId = prog.id;
        await prisma.programParticipant.create({ data: { programId, personId: childId, status: 'ACTIVE' } });
    });

    afterAll(async () => {
        await wipe();
        await prisma.$disconnect();
    });

    it('defaults the household to the caller and returns 201', async () => {
        as(leadId, familyHh);
        const res = await CREATE(post('/api/trusted-adults', { trustedAdultName: 'Grandma', trustedAdultPhone: '555-555-0100', familyContext: 'Maternal grandmother.' }));
        expect(res.status).toBe(201);
        const ta = await prisma.trustedAdult.findFirst({ where: { householdId: familyHh }, include: { reviews: true } });
        expect(ta?.trustedAdultPhone).toBe('555-555-0100');
        expect(ta?.trustedAdultEmail).toBeNull();
        expect(ta?.origin).toBe('SELF_DISCLOSED');
        expect(ta?.reviews[0].status).toBe('PENDING_BOARD_REVIEW');
    });

    it('forbids a non-staff member disclosing for a different household', async () => {
        as(leadId, familyHh);
        const res = await CREATE(post('/api/trusted-adults', { householdId: boardHh, trustedAdultName: 'X', trustedAdultPhone: '5555550100', familyContext: 'x' }));
        expect(res.status).toBe(403);
    });

    it('rejects a disclosure with neither phone nor email', async () => {
        as(leadId, familyHh);
        const res = await CREATE(post('/api/trusted-adults', { trustedAdultName: 'No Contact', familyContext: 'x' }));
        expect(res.status).toBe(400);
    });

    it('rejects a malformed email', async () => {
        as(leadId, familyHh);
        const res = await CREATE(post('/api/trusted-adults', { trustedAdultName: 'Bad Email', trustedAdultEmail: 'not-an-email', familyContext: 'x' }));
        expect(res.status).toBe(400);
    });

    it('approve needs a shared note; non-board is rejected', async () => {
        const ta = await prisma.trustedAdult.findFirst({ where: { householdId: familyHh }, include: { reviews: true } });
        const reviewId = ta!.reviews[0].id;

        as(leadId, familyHh); // not board
        expect((await DECISION(post('/api/safety/trusted-adults/decision', { reviewId, decision: 'APPROVE', sharedNote: SHARED }))).status).toBe(403);

        as(boardId, boardHh, { isBoardMember: true });
        expect((await DECISION(post('/api/safety/trusted-adults/decision', { reviewId, decision: 'APPROVE' }))).status).toBe(400);
        const ok = await DECISION(post('/api/safety/trusted-adults/decision', { reviewId, decision: 'APPROVE', sharedNote: SHARED }));
        expect(ok.status).toBe(200);
        expect((await ok.json()).status).toBe('APPROVED');
    });

    it('the family sees familyContext + the board shared note, not internal fields', async () => {
        as(leadId, familyHh);
        const body = await (await MINE(get('/api/trusted-adults/mine'))).json();
        const ta = body.trustedAdults[0];
        expect(ta.familyContext).toBeDefined();
        expect(ta.reviews[0].sharedNote).toBe(SHARED);
        expect(ta.origin).toBeUndefined();
        expect(ta.reviews[0].decisionNote).toBeUndefined();
    });

    it('operational view: isKeyholder sees the shared note but NOT familyContext', async () => {
        as(keyholderId, keyholderHh, { isKeyholder: true });
        const body = await (await OPERATIONAL(get('/api/trusted-adults/operational'))).json();
        const row = body.trustedAdults.find((t: { householdId: number }) => t.householdId === familyHh);
        expect(row).toBeTruthy();
        expect(row.trustedAdultName).toBe('Grandma');
        expect(row.reviews[0].sharedNote).toBe(SHARED);
        expect(row.familyContext).toBeUndefined(); // internal narrative band — never to keyholders
    });

    it('operational view: program lead of the household\'s child sees the shared note, not familyContext', async () => {
        as(programLeadId, programLeadHh);
        const body = await (await OPERATIONAL(get('/api/trusted-adults/operational'))).json();
        const row = body.trustedAdults.find((t: { householdId: number }) => t.householdId === familyHh);
        expect(row).toBeTruthy();
        expect(row.reviews[0].sharedNote).toBe(SHARED);
        expect(row.familyContext).toBeUndefined();
    });

    it('operational view: an unrelated member sees nothing', async () => {
        as(outsiderId, outsiderHh);
        const body = await (await OPERATIONAL(get('/api/trusted-adults/operational'))).json();
        const row = body.trustedAdults.find((t: { householdId: number }) => t.householdId === familyHh);
        expect(row).toBeUndefined();
    });

    it('board decision + override bind the actor on the review AND the TrustedAdult audit', async () => {
        // Fresh disclosure so this runs independently of the approve test's review.
        const ta = await prisma.trustedAdult.create({
            data: {
                householdId: familyHh, trustedAdultName: 'Grandpa', trustedAdultPhone: '555-0200',
                familyContext: 'Paternal grandfather.', origin: 'SELF_DISCLOSED', disclosedById: leadId,
                reviews: { create: { householdId: familyHh, kind: 'INITIAL', status: 'PENDING_BOARD_REVIEW' } },
            },
            include: { reviews: true },
        });
        const reviewId = ta.reviews[0].id;

        // Decision route, end-to-end as a board member.
        as(boardId, boardHh, { isBoardMember: true });
        const res = await DECISION(post('/api/safety/trusted-adults/decision', { reviewId, decision: 'APPROVE', sharedNote: SHARED }));
        expect(res.status).toBe(200);

        expect((await prisma.trustedAdultReview.findUnique({ where: { id: reviewId } }))?.decidedById).toBe(boardId);
        const decisionLog = await expectAuditRow(prisma, { action: 'EDIT', tableName: 'TrustedAdult', affectedEntityId: ta.id });
        expect(decisionLog.actorId).toBe(boardId);
        expect(auditJson(decisionLog.newData).decision).toBe('APPROVE');

        // Override negative: force-approve with no shared note -> 400 (STATUS_FOR[bad_input]).
        as(boardId, boardHh, { isBoardMember: true });
        expect((await OVERRIDE(post('/api/safety/trusted-adults/override', { reviewId, action: 'approve' }))).status).toBe(400);

        // Override route binds the same board actor on the review + a fresh audit row.
        const ok = await OVERRIDE(post('/api/safety/trusted-adults/override', { reviewId, action: 'approve', sharedNote: SHARED }));
        expect(ok.status).toBe(200);
        expect((await prisma.trustedAdultReview.findUnique({ where: { id: reviewId } }))?.decidedById).toBe(boardId);
        const overrideLog = await expectAuditRow(prisma, { action: 'EDIT', tableName: 'TrustedAdult', affectedEntityId: ta.id });
        expect(overrideLog.actorId).toBe(boardId);
        expect(auditJson(overrideLog.newData).override).toBe('approve');
    });

    // The override route's gate accepts a sysadmin in place of a board member, but the
    // conflict-of-interest check exempts no role: the household's own lead is refused
    // whether they reach the route as a bare sysadmin or as board+sysadmin.
    it("refuses a sysadmin overriding their OWN household's review, with or without the board role", async () => {
        const ta = await prisma.trustedAdult.create({
            data: {
                householdId: familyHh, trustedAdultName: 'Great-aunt', trustedAdultPhone: '555-0201',
                familyContext: 'Maternal great-aunt.', origin: 'SELF_DISCLOSED', disclosedById: leadId,
                reviews: { create: { householdId: familyHh, kind: 'INITIAL', status: 'PENDING_BOARD_REVIEW' } },
            },
            include: { reviews: true },
        });
        const reviewId = ta.reviews[0].id;

        for (const roles of [{ isSysadmin: true }, { isSysadmin: true, isBoardMember: true }]) {
            as(leadId, familyHh, roles);
            const res = await OVERRIDE(post('/api/safety/trusted-adults/override', { reviewId, action: 'approve', sharedNote: SHARED }));
            expect(res.status).toBe(403);
            expect((await res.json()).code).toBe('forbidden');
        }
        // Nothing decided: the review is still awaiting the board.
        const after = await prisma.trustedAdultReview.findUnique({ where: { id: reviewId } });
        expect(after?.status).toBe('PENDING_BOARD_REVIEW');
        expect(after?.decidedById).toBeNull();
    });

    // Full trusted-adult journey as one continuous flow through the real routes: a lead
    // SUBMITS → it's pending and NOT yet an authorized pickup → the board APPROVES →
    // it becomes an authorized pickup on the operational (front-desk) view → the nightly
    // sweep WARNS 30 days out (authorization still live) → then EXPIRES it (authorization
    // drops). The individual legs are unit-covered elsewhere; what this pins is the
    // pending→visible→warned→gone lifecycle of the pickup authorization end to end. Keyed
    // on this TA's id throughout, since other approved rows (Grandma/Grandpa) share familyHh.
    it('END-TO-END: submit → pending (no pickup) → board approve → authorized pickup → warn → expiry sweep drops it', async () => {
        const NOTE = 'Auntie May may pick up the kids.';

        // 1. A household lead submits a disclosure via the member-facing input route.
        as(leadId, familyHh);
        const created = await CREATE(post('/api/trusted-adults', {
            trustedAdultName: 'Auntie May', trustedAdultPhone: '555-555-0300',
            familyContext: 'Aunt; may collect the kids after school.',
        }));
        expect(created.status).toBe(201);
        const ta = await prisma.trustedAdult.findFirst({
            where: { householdId: familyHh, trustedAdultName: 'Auntie May' },
            include: { reviews: true },
        });
        expect(ta?.reviews).toHaveLength(1);
        expect(ta?.reviews[0].status).toBe('PENDING_BOARD_REVIEW'); // lands in the board queue
        const reviewId = ta!.reviews[0].id;

        // The pickup authorization the front desk acts on = this TA showing on the
        // keyholder's operational view. Re-read it at each stage of the lifecycle.
        const pickupRow = async () => {
            as(keyholderId, keyholderHh, { isKeyholder: true });
            const body = await (await OPERATIONAL(get('/api/trusted-adults/operational'))).json();
            return body.trustedAdults.find((t: { id: number }) => t.id === ta!.id);
        };

        // While pending, NOT an authorized pickup — existence isn't leaked before approval.
        expect(await pickupRow()).toBeUndefined();

        // 2. The board approves via the real decision route (shared note required to approve).
        as(boardId, boardHh, { isBoardMember: true });
        const decided = await DECISION(post('/api/safety/trusted-adults/decision', { reviewId, decision: 'APPROVE', sharedNote: NOTE }));
        expect(decided.status).toBe(200);
        expect((await decided.json()).status).toBe('APPROVED');

        // 3. Now an authorized pickup: the operational view surfaces the adult with the
        //    board's shared note (what the desk acts on), never the family's board-facing context.
        const authorized = await pickupRow();
        expect(authorized).toBeTruthy();
        expect(authorized.reviews[0].sharedNote).toBe(NOTE);
        expect(authorized.familyContext).toBeUndefined(); // internal narrative band — never on the pickup view

        // 4a. 30 days out: the sweep warns the family once. A warning does NOT revoke —
        //     the adult stays an authorized pickup while the family is reminded to renew.
        await prisma.trustedAdultReview.update({ where: { id: reviewId }, data: { reviewBy: new Date(Date.now() + 10 * 86400000), expiryWarningSentAt: null } });
        const warnRun = await runExpirySweep(new Date());
        expect(warnRun.warned).toBeGreaterThanOrEqual(1);
        expect((await prisma.trustedAdultReview.findUnique({ where: { id: reviewId } }))?.expiryWarningSentAt).not.toBeNull();
        expect(await pickupRow()).toBeTruthy(); // warned, but still authorized

        // 4b. Approval lapses: reviewBy in the past → the sweep EXPIRES it and the pickup
        //     authorization drops off the operational view.
        await prisma.trustedAdultReview.update({ where: { id: reviewId }, data: { reviewBy: new Date(Date.now() - 86400000) } });
        const expireRun = await runExpirySweep(new Date());
        expect(expireRun.expired).toBeGreaterThanOrEqual(1);
        expect((await prisma.trustedAdultReview.findUnique({ where: { id: reviewId } }))?.status).toBe('EXPIRED');
        expect(await pickupRow()).toBeUndefined(); // no longer an authorized pickup
    });
});
