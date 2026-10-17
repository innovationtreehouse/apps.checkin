/**
 * @jest-environment node
 */
/**
 * Integration Tests for Cron Pending-Participants API
 * Tests GET /api/cron/pending-participants — the NON-DESTRUCTIVE sweep that warns
 * unpaid PENDING enrollments at day 1/3/6 and flags day-7+ rows as overdue for the
 * board. The cron never removes anyone (reviewer decision: removal is a human,
 * board-driven action) — it warns the household and, at day 3+/7+, digests the
 * board once per run so a person decides what happens next.
 *
 * The route reads `pendingSince` and computes diffDays = floor((now - pendingSince)/day).
 * We seed enrollments with controlled pendingSince so each boundary is hit:
 *   day 1/3/6  -> warned, row survives
 *   day 7+     -> flagged overdue, row survives (never deleted)
 * isPaymentPlanRequested:true rows are filtered out of the query entirely and
 * therefore survive forever regardless of age.
 */

import { GET } from '@/app/api/cron/pending-participants/route';
import prisma from '@/lib/prisma';

jest.mock('@/lib/email');
// `@/lib/email`'s real module has no __getSentEmails/__clearSentEmails — those
// only exist on the manual mock (src/lib/__mocks__/email.ts) that jest.mock
// above swaps in. jest.requireMock (not a direct import) fetches that swapped
// instance so this typechecks against the mock's own shape.
const { __getSentEmails, __clearSentEmails } =
    jest.requireMock<typeof import('@/lib/__mocks__/email')>('@/lib/email');

const DAY_MS = 24 * 60 * 60 * 1000;
// Half-day offset puts each row safely inside its target day so floor() is stable.
const daysAgo = (now: number, d: number) => new Date(now - d * DAY_MS - DAY_MS / 2);

const mkReq = (auth?: string) => new Request('http://localhost:4000/api/cron/pending-participants', {
    method: 'GET',
    headers: auth ? { authorization: auth } : {}
}) as unknown as Request;

describe('Cron Pending-Participants API Integration Tests', () => {
    beforeEach(() => __clearSentEmails());

    describe('auth', () => {
        it('returns 401 when the Authorization header is missing', async () => {
            process.env.CRON_SECRET = 'test-secret';
            const res = await GET(mkReq());
            expect(res.status).toBe(401);
        });

        it('returns 401 when the cron secret is wrong', async () => {
            process.env.CRON_SECRET = 'test-secret';
            const res = await GET(mkReq('Bearer wrong-secret'));
            expect(res.status).toBe(401);
        });
    });

    describe('sweep at diffDays boundaries', () => {
        let programId: number;
        const ids: Record<string, number> = {};

        const mkParticipant = async (key: string) => {
            // Person.email is lowercased at write time by the emailNormalize Prisma
            // extension (src/lib/prismaEmailNormalize.ts), so every seed/assertion in
            // this file uses lowercase email strings throughout.
            const p = await prisma.person.create({
                data: { email: `${key.toLowerCase()}-pending-cron-test@example.com`, name: `${key} Pending Cron`, household: { create: { name: "Test HH" } } }
            });
            ids[key] = p.id;
            return p.id;
        };

        beforeAll(async () => {
            // Clean up any leaked state
            const leaked = await prisma.person.findMany({
                where: { email: { contains: 'pending-cron-test' } },
                select: { id: true }
            });
            const leakedIds = leaked.map(u => u.id);
            await prisma.programParticipant.deleteMany({ where: { personId: { in: leakedIds } } });
            await prisma.person.deleteMany({ where: { id: { in: leakedIds } } });
            await prisma.program.deleteMany({ where: { name: { contains: 'Pending Cron Test' } } });

            const program = await prisma.program.create({
                data: { startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: 'Pending Cron Test Program', phase: 'UPCOMING', enrollmentStatus: 'OPEN' }
            });
            programId = program.id;

            const now = Date.now();
            await mkParticipant('day1');
            await mkParticipant('day3');
            await mkParticipant('day6');
            await mkParticipant('day7');
            await mkParticipant('plan'); // PENDING_HELD (req=true, seat held) -> never swept
            await mkParticipant('holdFailed'); // PENDING_HOLD_FAILED (req=true, held=null) -> also never swept
            await mkParticipant('denied'); // denied applicant -> grace-expiry cron's job, never this sweep's

            await prisma.programParticipant.createMany({
                data: [
                    { programId, personId: ids.day1, status: 'PENDING', pendingSince: daysAgo(now, 1) },
                    { programId, personId: ids.day3, status: 'PENDING', pendingSince: daysAgo(now, 3) },
                    { programId, personId: ids.day6, status: 'PENDING', pendingSince: daysAgo(now, 6) },
                    { programId, personId: ids.day7, status: 'PENDING', pendingSince: daysAgo(now, 7) },
                    // A genuine held request stamps inventoryHeldAt (that's what the apply-time -1 does).
                    { programId, personId: ids.plan, status: 'PENDING', pendingSince: daysAgo(now, 8), isPaymentPlanRequested: true, inventoryHeldAt: daysAgo(now, 8) },
                    // PENDING_HOLD_FAILED: the apply-time -1 failed, so req=true but no seat is held.
                    // isPaymentPlanRequested=true still excludes it from the sweep — it is the board's
                    // problem (Shopify reconciliation queue), NEVER the applicant's, so it must survive.
                    { programId, personId: ids.holdFailed, status: 'PENDING', pendingSince: daysAgo(now, 9), isPaymentPlanRequested: true, inventoryHeldAt: null },
                    // Denied 10 days after enrolling: pendingSince is way past the 7-day
                    // overdue tier, but paymentPlanDeniedAt hands the timeline to scholarship-grace-expiry.
                    { programId, personId: ids.denied, status: 'PENDING', pendingSince: daysAgo(now, 10), isPaymentPlanRequested: false, paymentPlanDeniedAt: daysAgo(now, 0), inventoryHeldAt: daysAgo(now, 10) },
                ]
            });
        });

        afterAll(async () => {
            const idList = Object.values(ids);
            await prisma.programParticipant.deleteMany({ where: { programId } });
            await prisma.person.deleteMany({ where: { id: { in: idList } } });
            await prisma.program.deleteMany({ where: { id: programId } });
        });

        it('warns at days 1/3/6, flags day 7+ as overdue, and never deletes anyone', async () => {
            process.env.CRON_SECRET = 'test-secret';
            const res = await GET(mkReq('Bearer test-secret'));
            expect(res.status).toBe(200);

            const data = await res.json();
            expect(data.success).toBe(true);
            // day1, day3, day6, day7 are PENDING + no payment plan -> processed.
            expect(data.processed).toBe(4);
            // day1, day3, day6 warned; day7 overdue.
            expect(data.warned).toBe(3);
            expect(data.overdue).toBe(1);
            expect(data).not.toHaveProperty('kicked');

            // DB reality: nothing is deleted — every row, including day7, survives.
            const survivors = await prisma.programParticipant.findMany({ where: { programId } });
            const survivorPids = survivors.map(s => s.personId).sort((a, b) => a - b);
            expect(survivorPids).toEqual([ids.day1, ids.day3, ids.day6, ids.day7, ids.plan, ids.holdFailed, ids.denied].sort((a, b) => a - b));

            const day7 = await prisma.programParticipant.findUnique({
                where: { programId_personId: { programId, personId: ids.day7 } }
            });
            expect(day7).not.toBeNull();
        });
    });

    describe('leadership digest — nothing due', () => {
        let programId: number;
        let personId: number;

        beforeAll(async () => {
            const leaked = await prisma.person.findMany({
                where: { email: { contains: 'pending-cron-nodigest-test' } },
                select: { id: true }
            });
            const leakedIds = leaked.map(u => u.id);
            await prisma.programParticipant.deleteMany({ where: { personId: { in: leakedIds } } });
            await prisma.person.deleteMany({ where: { id: { in: leakedIds } } });
            await prisma.program.deleteMany({ where: { name: 'Pending Cron NoDigest Test Program' } });

            const program = await prisma.program.create({
                data: { startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: 'Pending Cron NoDigest Test Program', phase: 'UPCOMING', enrollmentStatus: 'OPEN' }
            });
            programId = program.id;

            const person = await prisma.person.create({
                data: { email: 'nodigest-pending-cron-nodigest-test@example.com', name: 'NoDigest Person', household: { create: { name: 'NoDigest HH' } } }
            });
            personId = person.id;

            // day-1 only: warned, but neither the "approaching" (day 3) nor
            // "overdue" (day 7+) digest tier.
            await prisma.programParticipant.create({
                data: { programId, personId, status: 'PENDING', pendingSince: daysAgo(Date.now(), 1) }
            });
        });

        afterAll(async () => {
            await prisma.programParticipant.deleteMany({ where: { programId } });
            await prisma.person.deleteMany({ where: { id: personId } });
            await prisma.program.deleteMany({ where: { id: programId } });
        });

        it('sends no leadership digest when nothing is at day-3/7+', async () => {
            process.env.CRON_SECRET = 'test-secret';
            const res = await GET(mkReq('Bearer test-secret'));
            expect(res.status).toBe(200);

            const sent = __getSentEmails();
            const digest = sent.filter((e) => e.subject.startsWith('Non-payment digest:') && e.to === 'board-pending-cron-email-test@example.com');
            // Scoped to this suite's board member: emailBoardMembers fans out to EVERY
            // isBoardMember row, and other suites' board personas share the DB in CI.
            expect(digest).toHaveLength(0);
        });
    });

    describe('email dispatch', () => {
        // Own program (distinct name -> distinct subject text) so assertions here
        // can't be confused by other describes' rows, which survive and get
        // re-processed every time GET runs later in the file.
        let emailProgramId: number;
        let householdAId: number;
        let householdBId: number;
        let householdOverdueId: number;
        let householdBoardId: number;
        const eids: Record<string, number> = {};

        beforeAll(async () => {
            const leaked = await prisma.person.findMany({
                where: { email: { contains: 'pending-cron-email-test' } },
                select: { id: true }
            });
            const leakedIds = leaked.map(u => u.id);
            await prisma.programParticipant.deleteMany({ where: { personId: { in: leakedIds } } });
            await prisma.person.deleteMany({ where: { id: { in: leakedIds } } });
            await prisma.program.deleteMany({ where: { name: 'Pending Cron Email Test Program' } });

            const program = await prisma.program.create({
                data: { startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: 'Pending Cron Email Test Program', phase: 'UPCOMING', enrollmentStatus: 'OPEN' }
            });
            emailProgramId = program.id;

            // Household A: a lead + a child (both have email) -> day-6 FINAL WARNING
            // must reach both the lead's address and the participant's own address.
            const householdA = await prisma.household.create({ data: { name: 'Email Test HH A' } });
            householdAId = householdA.id;
            const leadA = await prisma.person.create({
                data: { email: 'leada-pending-cron-email-test@example.com', name: 'Lead A', householdId: householdAId, isHouseholdLead: true }
            });
            const day6Child = await prisma.person.create({
                data: { email: 'day6child-pending-cron-email-test@example.com', name: 'Day6 Child', householdId: householdAId }
            });
            eids.leadA = leadA.id;
            eids.day6Child = day6Child.id;

            // Household B: a lead (has email) + a child with NO email -> only the lead
            // should be resolved; the child drops out silently, nothing errors. This
            // child is also the "approaching deadline" (day 3) person in the digest.
            const householdB = await prisma.household.create({ data: { name: 'Email Test HH B' } });
            householdBId = householdB.id;
            const leadB = await prisma.person.create({
                data: { email: 'leadb-pending-cron-email-test@example.com', name: 'Lead B', householdId: householdBId, isHouseholdLead: true }
            });
            const noEmailChild = await prisma.person.create({
                data: { email: null, name: 'No Email Child', householdId: householdBId }
            });
            eids.leadB = leadB.id;
            eids.noEmailChild = noEmailChild.id;

            // Day-8 candidate: overdue, but NEVER removed by the cron anymore — it
            // only shows up in the leadership digest, flagged for a human to act on.
            const householdC = await prisma.household.create({ data: { name: 'Email Test HH C' } });
            householdOverdueId = householdC.id;
            const overdue = await prisma.person.create({
                data: { email: 'overdue-pending-cron-email-test@example.com', name: 'Overdue Person', householdId: householdOverdueId }
            });
            eids.overdue = overdue.id;

            // Board member: the digest's only recipient.
            const boardHousehold = await prisma.household.create({ data: { name: 'Email Test HH Board' } });
            householdBoardId = boardHousehold.id;
            const board = await prisma.person.create({
                data: { email: 'board-pending-cron-email-test@example.com', name: 'Board Member', householdId: householdBoardId, isBoardMember: true }
            });
            eids.board = board.id;

            const now = Date.now();
            await prisma.programParticipant.createMany({
                data: [
                    { programId: emailProgramId, personId: eids.day6Child, status: 'PENDING', pendingSince: daysAgo(now, 6) },
                    { programId: emailProgramId, personId: eids.noEmailChild, status: 'PENDING', pendingSince: daysAgo(now, 3) },
                    { programId: emailProgramId, personId: eids.overdue, status: 'PENDING', pendingSince: daysAgo(now, 8) },
                ]
            });
        });

        afterAll(async () => {
            const idList = Object.values(eids);
            await prisma.programParticipant.deleteMany({ where: { programId: emailProgramId } });
            await prisma.person.deleteMany({ where: { id: { in: idList } } });
            await prisma.program.deleteMany({ where: { id: emailProgramId } });
            await prisma.household.deleteMany({ where: { id: { in: [householdAId, householdBId, householdOverdueId, householdBoardId] } } });
        });

        it('sends real warning emails, once per rule, only for live rows, and never a removal email', async () => {
            process.env.CRON_SECRET = 'test-secret';
            const res = await GET(mkReq('Bearer test-secret'));
            expect(res.status).toBe(200);

            const sent = __getSentEmails();

            // day-6 FINAL WARNING -> household lead AND the participant, both have email.
            const finalWarning = sent.filter((e) => e.subject === 'FINAL WARNING: 24 hours left to pay for Pending Cron Email Test Program');
            expect(finalWarning.map((e) => e.to).sort()).toEqual([
                'day6child-pending-cron-email-test@example.com',
                'leada-pending-cron-email-test@example.com',
            ]);
            expect(finalWarning[0].html).toContain('Pending Cron Email Test Program');
            expect(finalWarning[0].html).toContain('may be released by the board');

            // day-3 reminder for the null-email child -> only the lead is resolved; no throw.
            const day3Warning = sent.filter((e) => e.subject === 'Please pay for Pending Cron Email Test Program within 4 days');
            expect(day3Warning.map((e) => e.to)).toEqual(['leadb-pending-cron-email-test@example.com']);

            // No removal email exists anymore, for anyone, at any age.
            const removalEmails = sent.filter((e) => e.subject.includes('Removed from'));
            expect(removalEmails).toHaveLength(0);

            // (a) day-8 row is NOT deleted.
            const overdueRow = await prisma.programParticipant.findUnique({
                where: { programId_personId: { programId: emailProgramId, personId: eids.overdue } }
            });
            expect(overdueRow).not.toBeNull();
        });

        it('sends exactly one leadership digest to the board, covering the day-3 and day-8 people', async () => {
            process.env.CRON_SECRET = 'test-secret';
            const res = await GET(mkReq('Bearer test-secret'));
            expect(res.status).toBe(200);

            const sent = __getSentEmails();
            const digest = sent.filter((e) => e.subject.startsWith('Non-payment digest:') && e.to === 'board-pending-cron-email-test@example.com');
            // Scoped to this suite's board member: emailBoardMembers fans out to EVERY
            // isBoardMember row, and other suites' board personas share the DB in CI.
            expect(digest).toHaveLength(1);
            expect(digest[0].to).toBe('board-pending-cron-email-test@example.com');
            expect(digest[0].html).toContain('No Email Child — Pending Cron Email Test Program (day 3)');
            expect(digest[0].html).toContain('Overdue Person — Pending Cron Email Test Program (day 8)');
            expect(digest[0].html).toContain('action needed: remove the enrollment or contact the household');
        });
    });
});
