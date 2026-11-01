/**
 * @jest-environment node
 */
/**
 * Concurrency tests for trusted-adult mutating operations. Like the membership
 * BG-review flow (lib/membership/review.ts FOR UPDATE), these check then act, so
 * they need a row lock. Without one:
 *   - renewTrustedAdult: two concurrent renews both read a terminal latest review,
 *     both pass the "already open" guard, both create a PENDING review → TWO open
 *     reviews for one trusted adult.
 *   - decideReview: two board members both read PENDING_BOARD_REVIEW, both update
 *     and both write an audit row → the loser leaves an ORPHAN audit row that
 *     contradicts the final state.
 *
 * These serialize on a SELECT ... FOR UPDATE of the parent TrustedAdult row inside
 * a $transaction (mirrors review.ts). jest.setup.js gives this suite
 * TEST_DB_POOL_MAX=2 so the two writes run on separate connections — the row lock,
 * not pool-1 serialization, is what makes them safe.
 */

import { createTrustedAdult, decideReview, renewTrustedAdult, TrustedAdultError } from '@/lib/trusted-adult/service';
import { normalizeAuditData } from '@/lib/auditPayload';
import prisma from '@/lib/prisma';

const sendEmail = jest.fn().mockResolvedValue(true);
jest.mock('@/lib/email', () => ({
    sendEmail: (...a: unknown[]) => sendEmail(...a),
    runPaced: (tasks: Array<() => Promise<unknown>>) => Promise.all(tasks.map((t) => t())),
}));

const TAG = 'trustedadult-concurrency-test';
const SHARED = 'Grandma may pick up the kids.';

async function wipe() {
    const hhs = await prisma.household.findMany({ where: { name: { contains: TAG } }, select: { id: true } });
    const ids = hhs.map((h) => h.id);
    if (ids.length) {
        await prisma.trustedAdultReview.deleteMany({ where: { householdId: { in: ids } } });
        await prisma.trustedAdult.deleteMany({ where: { householdId: { in: ids } } });
        await prisma.person.deleteMany({ where: { householdId: { in: ids } } });
        await prisma.household.deleteMany({ where: { id: { in: ids } } });
    }
}

function code(r: PromiseSettledResult<unknown>): string {
    return r.status === 'fulfilled' ? 'fulfilled' : (r.reason as TrustedAdultError).code;
}

describe('trusted-adult mutation concurrency', () => {
    let householdId = 0;
    let leadId = 0;
    let boardId = 0;

    beforeAll(async () => {
        await wipe();
        const hh = await prisma.household.create({ data: { name: `Family HH ${TAG}` } });
        householdId = hh.id;
        const lead = await prisma.person.create({ data: { name: 'Lead', email: `lead-${TAG}@ex.com`, householdId: hh.id } });
        leadId = lead.id;
        await prisma.person.update({ where: { id: lead.id }, data: { isHouseholdLead: true } });
        const boardHh = await prisma.household.create({ data: { name: `Board HH ${TAG}` } });
        boardId = (await prisma.person.create({ data: { name: 'Boardie', isBoardMember: true, householdId: boardHh.id } })).id;
    });

    afterAll(async () => {
        await wipe();
        await prisma.$disconnect();
    });

    async function disclose() {
        return createTrustedAdult({
            householdId,
            trustedAdultName: 'Jane External',
            trustedAdultEmail: 'jane@example.com',
            familyContext: 'Our nanny; may collect the kids on weekdays.',
            disclosedById: leadId,
        });
    }

    it('two concurrent renewals open exactly ONE pending review (not two)', async () => {
        // Latest review terminal (APPROVED) so a renewal is allowed.
        const ta = await disclose();
        await decideReview(ta.reviews[0].id, boardId, { decision: 'APPROVE', sharedNote: SHARED });

        const [a, b] = await Promise.allSettled([
            renewTrustedAdult(ta.id, leadId),
            renewTrustedAdult(ta.id, leadId),
        ]);
        const codes = [code(a), code(b)];

        // Exactly one renewal wins; the other re-reads the now-open review under the
        // lock and bails with already_open. Unlocked, BOTH win and two PENDING reviews open.
        expect(codes.filter((c) => c === 'fulfilled')).toHaveLength(1);
        expect(codes.filter((c) => c === 'already_open')).toHaveLength(1);

        const pending = await prisma.trustedAdultReview.count({
            where: { trustedAdultId: ta.id, status: 'PENDING_BOARD_REVIEW' },
        });
        expect(pending).toBe(1);
    });

    it('two concurrent decisions on one review — one wins, no orphan audit', async () => {
        const ta = await disclose();
        const reviewId = ta.reviews[0].id;

        const [a, b] = await Promise.allSettled([
            decideReview(reviewId, boardId, { decision: 'APPROVE', sharedNote: SHARED }),
            decideReview(reviewId, boardId, { decision: 'DENY' }),
        ]);
        const codes = [code(a), code(b)];

        // One decision lands; the loser re-reads a non-PENDING review and bails.
        expect(codes.filter((c) => c === 'fulfilled')).toHaveLength(1);
        expect(codes.filter((c) => c === 'wrong_phase')).toHaveLength(1);

        const review = await prisma.trustedAdultReview.findUnique({ where: { id: reviewId } });
        expect(['APPROVED', 'DENIED']).toContain(review!.status);

        // Exactly ONE decision audit row, and it matches the final state — unlocked, the
        // loser also writes an audit row whose decision contradicts the persisted one.
        const audits = await prisma.auditLog.findMany({
            where: { tableName: 'TrustedAdult', affectedEntityId: ta.id },
            select: { newData: true },
        });
        const decisions = audits.filter((x) => JSON.stringify(normalizeAuditData(x.newData)).includes('"decision":'));
        expect(decisions).toHaveLength(1);
        expect(JSON.stringify(normalizeAuditData(decisions[0].newData))).toContain(`"status":"${review!.status}"`);
    });
});
