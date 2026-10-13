/**
 * @jest-environment node
 */
/**
 * Validator-oracle integration tests.
 *
 * Drives each real transition (T3, T3f, T3m, T4, T5, T6, T7/T8/T9) against a real
 * DB through its OWNING code — the route handler / shared mutator that carries the
 * guard — then asserts the resulting row `classify`es to the expected state and
 * `validate`s clean. A simulated crash window (activate's first updateMany, skip
 * the release) must be flagged as an I1 violation.
 *
 * The definition is non-behavioral: this proves the guards land rows exactly on
 * the six §3 states, never off-diagram.
 */
import { POST as RequestPost } from '@/app/api/programs/[id]/request-payment-plan/route';
import { POST as ManualHoldPost } from '@/app/api/finance-ops/payment-plans/manual-hold/route';
import { POST as PlansPost } from '@/app/api/finance-ops/payment-plans/route';
import { POST as RefusePost } from '@/app/api/finance-ops/payment-plans/refuse/route';
import { activateProgramEnrollment } from '@/lib/programs/activateEnrollment';
import { withdrawAndReleaseHold } from '@/lib/program/capacity';
import prisma from '@/lib/prisma';
import { classify, validate, toRow, type EnrollmentStateName } from '@/lib/programs/enrollmentState';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));
jest.mock('@/lib/notifications', () => ({ sendNotification: jest.fn() }));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const mockSession = require('next-auth/next').getServerSession;

const TAG = 'enroll-oracle-test';

describe('enrollment state — validator oracle over real transitions', () => {
    let programId: number;
    let selfId: number;
    let boardId: number;

    beforeAll(async () => {
        const self = await prisma.person.create({
            // Adult DOB: the oracle drives self-service transitions (request a
            // payment plan), which only a known adult may do.
            data: {
                name: 'Oracle Self',
                email: `self-${TAG}@example.com`,
                dateOfBirth: new Date(Date.now() - (30 * 31556952000)),
                household: { create: { name: 'HH' } },
            },
        });
        selfId = self.id;
        const board = await prisma.person.create({
            data: { name: 'Oracle Board', email: `board-${TAG}@example.com`, isBoardMember: true, household: { create: { name: 'HH' } } },
        });
        boardId = board.id;
        // shopifyVariantId present so the apply-time hold logic engages (single pool).
        const program = await prisma.program.create({
            data: { startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: `Oracle Program ${TAG}`, enrollmentStatus: 'OPEN', shopifyVariantId: 'dev-mock-variant-oracle' },
        });
        programId = program.id;
    });

    afterAll(async () => {
        await prisma.programParticipant.deleteMany({ where: { programId } });
        await prisma.program.delete({ where: { id: programId } });
        const ids = [selfId, boardId];
        const people = await prisma.person.findMany({ where: { id: { in: ids } }, select: { householdId: true } });
        await prisma.person.deleteMany({ where: { id: { in: ids } } });
        await prisma.household.deleteMany({ where: { id: { in: people.map((p) => p.householdId) } } });
    });

    beforeEach(() => jest.clearAllMocks());

    // Seed the FROM row directly (setup, not a transition-under-test).
    async function seed(fields: { req: boolean; held: boolean; den: boolean; status?: 'PENDING' | 'ACTIVE'; pendingSince?: Date }) {
        const now = new Date();
        await prisma.programParticipant.upsert({
            where: { programId_personId: { programId, personId: selfId } },
            update: {
                status: fields.status ?? 'PENDING',
                isPaymentPlanRequested: fields.req,
                inventoryHeldAt: fields.held ? now : null,
                paymentPlanDeniedAt: fields.den ? now : null,
                pendingSince: fields.pendingSince ?? now,
            },
            create: {
                programId, personId: selfId,
                status: fields.status ?? 'PENDING',
                isPaymentPlanRequested: fields.req,
                inventoryHeldAt: fields.held ? now : null,
                paymentPlanDeniedAt: fields.den ? now : null,
                pendingSince: fields.pendingSince ?? now,
            },
        });
    }

    async function assertState(expected: EnrollmentStateName) {
        const dbRow = await prisma.programParticipant.findUniqueOrThrow({
            where: { programId_personId: { programId, personId: selfId } },
        });
        const r = toRow(dbRow);
        expect(classify(r)).toBe(expected);
        expect(validate(r)).toBeNull();
    }

    async function assertGone() {
        const row = await prisma.programParticipant.findUnique({
            where: { programId_personId: { programId, personId: selfId } },
        });
        expect(row).toBeNull(); // UNENROLLED
    }

    const reqReq = () => new Request(`http://localhost/api/programs/${programId}/request-payment-plan`, {
        method: 'POST', headers: { cookie: 'session=test' }, body: JSON.stringify({ participantId: selfId }),
    }) as unknown as import('next/server').NextRequest;
    const params = () => ({ params: Promise.resolve({ id: String(programId) }) });
    const financeReq = (url: string) => new Request(url, {
        method: 'POST', headers: { cookie: 'session=test' }, body: JSON.stringify({ programId, participantId: selfId }),
    }) as unknown as import('next/server').NextRequest;

    it('T3 apply (−1 ok): PENDING_UNPAID → PENDING_HELD', async () => {
        const prev = process.env.CHECKIN_ENV;
        process.env.CHECKIN_ENV = 'local'; // arms the Shopify mock → the −1 "succeeds"
        try {
            await seed({ req: false, held: false, den: false }); // PENDING_UNPAID
            mockSession.mockResolvedValue({ user: { id: selfId } });
            const res = await RequestPost(reqReq(), params());
            expect(res.status).toBe(200);
            await assertState('PENDING_HELD');
        } finally {
            process.env.CHECKIN_ENV = prev;
        }
    });

    it('T3f apply (−1 FAILS): PENDING_UNPAID → PENDING_HOLD_FAILED', async () => {
        const prev = process.env.CHECKIN_ENV;
        delete process.env.CHECKIN_ENV; // no mock, no creds → adjust returns false → rollback
        try {
            await seed({ req: false, held: false, den: false }); // PENDING_UNPAID
            mockSession.mockResolvedValue({ user: { id: selfId } });
            const res = await RequestPost(reqReq(), params());
            expect(res.status).toBe(200);
            expect((await res.json()).warning).toMatch(/board/i);
            await assertState('PENDING_HOLD_FAILED');
        } finally {
            if (prev !== undefined) process.env.CHECKIN_ENV = prev;
        }
    });

    it('T3m manual-hold: PENDING_HOLD_FAILED → PENDING_HELD', async () => {
        await seed({ req: true, held: false, den: false }); // PENDING_HOLD_FAILED
        mockSession.mockResolvedValue({ user: { id: boardId, isBoardMember: true } });
        const res = await ManualHoldPost(financeReq('http://localhost/api/finance-ops/payment-plans/manual-hold'));
        expect(res.status).toBe(200);
        await assertState('PENDING_HELD');
    });

    it('T4 activate (payment) from PENDING_HELD → ACTIVE, hold released', async () => {
        await seed({ req: true, held: true, den: false }); // PENDING_HELD
        const { activatedCount, releasedHoldCount } = await activateProgramEnrollment({
            programId, personIds: [selfId], shopifyOrderId: 'order-oracle-1',
        });
        expect(activatedCount).toBe(1);
        expect(releasedHoldCount).toBe(1);
        await assertState('ACTIVE');
    });

    it('T4 activate (payment) from PENDING_UNPAID → ACTIVE, no hold to release', async () => {
        await seed({ req: false, held: false, den: false }); // PENDING_UNPAID
        const { activatedCount, releasedHoldCount } = await activateProgramEnrollment({
            programId, personIds: [selfId], shopifyOrderId: 'order-oracle-2',
        });
        expect(activatedCount).toBe(1);
        expect(releasedHoldCount).toBe(0);
        await assertState('ACTIVE');
    });

    it('T5 approve: PENDING_HELD → ACTIVE (hold consumed, not released)', async () => {
        await seed({ req: true, held: true, den: false }); // PENDING_HELD
        mockSession.mockResolvedValue({ user: { id: boardId, isBoardMember: true } });
        const res = await PlansPost(financeReq('http://localhost/api/finance-ops/payment-plans'));
        expect(res.status).toBe(200);
        await assertState('ACTIVE');
    });

    it('T6 deny: PENDING_HELD → PENDING_HELD_DENIED', async () => {
        await seed({ req: true, held: true, den: false }); // PENDING_HELD
        mockSession.mockResolvedValue({ user: { id: boardId, isBoardMember: true } });
        const res = await RefusePost(financeReq('http://localhost/api/finance-ops/payment-plans/refuse'));
        expect(res.status).toBe(200);
        await assertState('PENDING_HELD_DENIED');
    });

    // T7/T8/T9 all funnel through the one shared exit (withdrawAndReleaseHold);
    // their end-state is UNENROLLED (row deleted), with +1 iff the row still held.
    it('T7 non-payment kick: PENDING_UNPAID → ∅ (no hold, no +1)', async () => {
        await seed({ req: false, held: false, den: false }); // PENDING_UNPAID
        const program = await prisma.program.findUniqueOrThrow({ where: { id: programId } });
        const { released } = await withdrawAndReleaseHold(programId, selfId, program);
        expect(released).toBe(false);
        await assertGone();
    });

    it('T8 grace expiry: PENDING_HELD_DENIED → ∅ (held → +1)', async () => {
        await seed({ req: false, held: true, den: true }); // PENDING_HELD_DENIED
        const program = await prisma.program.findUniqueOrThrow({ where: { id: programId } });
        const { released } = await withdrawAndReleaseHold(programId, selfId, program);
        expect(released).toBe(true);
        await assertGone();
    });

    it('T9 withdraw: PENDING_HELD → ∅ (held → +1)', async () => {
        await seed({ req: true, held: true, den: false }); // PENDING_HELD
        const program = await prisma.program.findUniqueOrThrow({ where: { id: programId } });
        const { released } = await withdrawAndReleaseHold(programId, selfId, program);
        expect(released).toBe(true);
        await assertGone();
    });

    it('crash window (activate step 1 committed, release skipped) → I1 violation flagged', async () => {
        await seed({ req: true, held: true, den: false }); // PENDING_HELD, seat held
        // Reproduce ONLY activate's first updateMany (status→ACTIVE); crash before
        // the hold-release updateMany. The committed intermediate row holds a seat
        // while ACTIVE — the exact §7 two-step crash window.
        await prisma.programParticipant.updateMany({
            where: { programId, personId: selfId, status: 'PENDING' },
            data: { status: 'ACTIVE', pendingSince: null, shopifyOrderId: 'order-crash' },
        });
        const dbRow = await prisma.programParticipant.findUniqueOrThrow({
            where: { programId_personId: { programId, personId: selfId } },
        });
        const r = toRow(dbRow);
        expect(classify(r)).toBeNull(); // off-diagram
        expect(validate(r)).toEqual({ invariant: 'I1' });
    });
});
