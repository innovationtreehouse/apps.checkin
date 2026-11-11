/**
 * @jest-environment node
 */
/**
 * Atomicity: every mutating trusted-adult op writes its state change and its
 * audit row inside ONE prisma.$transaction. If the audit insert fails, the state
 * change must roll back with it — no granted/denied/revoked record left without
 * an audit trail.
 *
 * We force the audit insert to throw by wrapping the interactive transaction's
 * `tx` client so `tx.auditLog.create` blows up. With a state update and a separate
 * audit await, the update would already be committed and these assertions would fail.
 */

import {
    createTrustedAdult,
    decideReview,
    overrideReview,
    renewTrustedAdult,
    runExpirySweep,
    withdrawTrustedAdult,
} from '@/lib/trusted-adult/service';
import prisma from '@/lib/prisma';

const sendEmail = jest.fn().mockResolvedValue(true);
jest.mock('@/lib/email', () => ({
    sendEmail: (...a: unknown[]) => sendEmail(...a),
    runPaced: (tasks: Array<() => Promise<unknown>>) => Promise.all(tasks.map((t) => t())),
}));

const TAG = 'trustedadult-atomicity-test';

/** Make `tx.auditLog.create` throw inside the real interactive transaction. */
function breakAuditInTransaction() {
    const realTransaction = prisma.$transaction.bind(prisma);
    const impl = (arg: unknown) => {
        if (typeof arg !== 'function') {
            return (realTransaction as (a: unknown) => unknown)(arg);
        }
        const fn = arg as (tx: unknown) => unknown;
        return (realTransaction as (cb: (tx: unknown) => unknown) => unknown)((tx) => {
            const proxy = new Proxy(tx as Record<string, unknown>, {
                get(target, prop) {
                    if (prop === 'auditLog') {
                        return { create: () => { throw new Error('forced audit failure'); } };
                    }
                    return target[prop as string];
                },
            });
            return fn(proxy);
        });
    };
    return jest
        .spyOn(prisma, '$transaction')
        .mockImplementation(impl as unknown as typeof prisma.$transaction);
}

describe('Trusted Adults — mutation + audit are atomic', () => {
    let householdId = 0;
    let leadId = 0;
    let boardId = 0;

    async function wipe() {
        const hhs = await prisma.household.findMany({ where: { name: { contains: TAG } }, select: { id: true } });
        const ids = hhs.map((h) => h.id);
        if (ids.length) {
            await prisma.trustedAdultReview.deleteMany({ where: { householdId: { in: ids } } });
            await prisma.trustedAdult.deleteMany({ where: { householdId: { in: ids } } });
        }
        await prisma.person.deleteMany({ where: { householdId: { in: ids } } });
        await prisma.household.deleteMany({ where: { id: { in: ids } } });
    }

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

    afterEach(() => jest.restoreAllMocks());

    async function discloseOne() {
        return createTrustedAdult({
            householdId,
            trustedAdultName: 'Jane External',
            trustedAdultEmail: 'jane@example.com',
            familyContext: 'Our nanny; may collect the kids on weekdays.',
            disclosedById: leadId,
        });
    }

    it('decideReview: a failing audit rolls back the APPROVE — status stays PENDING_BOARD_REVIEW', async () => {
        const ta = await discloseOne();
        const reviewId = ta.reviews[0].id;

        const spy = breakAuditInTransaction();
        await expect(
            decideReview(reviewId, boardId, { decision: 'APPROVE', sharedNote: 'Grandma may pick up the kids.' }),
        ).rejects.toThrow('forced audit failure');
        spy.mockRestore();

        const after = await prisma.trustedAdultReview.findUnique({ where: { id: reviewId } });
        expect(after!.status).toBe('PENDING_BOARD_REVIEW'); // NOT APPROVED
        expect(after!.decision).toBeNull();
        expect(after!.reviewBy).toBeNull();
    });

    it('withdrawTrustedAdult: a failing audit rolls back the REVOKE — status stays PENDING_BOARD_REVIEW', async () => {
        const ta = await discloseOne();
        const reviewId = ta.reviews[0].id;

        const spy = breakAuditInTransaction();
        await expect(withdrawTrustedAdult(ta.id, leadId)).rejects.toThrow('forced audit failure');
        spy.mockRestore();

        const after = await prisma.trustedAdultReview.findUnique({ where: { id: reviewId } });
        expect(after!.status).toBe('PENDING_BOARD_REVIEW'); // NOT REVOKED
    });

    it('createTrustedAdult: a failing audit rolls back the whole create — no TA, review, or audit row', async () => {
        const taBefore = await prisma.trustedAdult.count({ where: { householdId } });
        const auditBefore = await prisma.auditLog.count();

        const spy = breakAuditInTransaction();
        await expect(discloseOne()).rejects.toThrow('forced audit failure');
        spy.mockRestore();

        // TA + its INITIAL review are created inside the same tx as the audit — all roll back.
        expect(await prisma.trustedAdult.count({ where: { householdId } })).toBe(taBefore);
        expect(await prisma.auditLog.count()).toBe(auditBefore);
    });

    it('renewTrustedAdult: a failing audit rolls back the RENEWAL — no new review, no audit row', async () => {
        const ta = await discloseOne();
        // Renew is allowed only when the latest review is terminal; withdraw to REVOKED first.
        await withdrawTrustedAdult(ta.id, leadId);

        const reviewsBefore = await prisma.trustedAdultReview.count({ where: { trustedAdultId: ta.id } });
        const auditBefore = await prisma.auditLog.count();

        const spy = breakAuditInTransaction();
        await expect(renewTrustedAdult(ta.id, leadId)).rejects.toThrow('forced audit failure');
        spy.mockRestore();

        expect(await prisma.trustedAdultReview.count({ where: { trustedAdultId: ta.id } })).toBe(reviewsBefore);
        expect(await prisma.auditLog.count()).toBe(auditBefore);
    });

    it('overrideReview: a failing audit rolls back the force-DENY — status stays PENDING_BOARD_REVIEW', async () => {
        const ta = await discloseOne();
        const reviewId = ta.reviews[0].id;
        const auditBefore = await prisma.auditLog.count();

        const spy = breakAuditInTransaction();
        await expect(overrideReview(reviewId, boardId, 'deny')).rejects.toThrow('forced audit failure');
        spy.mockRestore();

        const after = await prisma.trustedAdultReview.findUnique({ where: { id: reviewId } });
        expect(after!.status).toBe('PENDING_BOARD_REVIEW'); // NOT DENIED
        expect(after!.decision).toBeNull();
        expect(await prisma.auditLog.count()).toBe(auditBefore);
    });

    it('runExpirySweep: a failing audit rolls back the EXPIRED transition — status stays APPROVED', async () => {
        const ta = await discloseOne();
        const reviewId = ta.reviews[0].id;
        await decideReview(reviewId, boardId, { decision: 'APPROVE', sharedNote: 'Grandma may pick up the kids.' });
        // Push reviewBy into the past so the sweep treats this approval as lapsed.
        await prisma.trustedAdultReview.update({ where: { id: reviewId }, data: { reviewBy: new Date('2000-01-01T00:00:00Z') } });

        const auditBefore = await prisma.auditLog.count();

        const spy = breakAuditInTransaction();
        await expect(runExpirySweep(new Date())).rejects.toThrow('forced audit failure');
        spy.mockRestore();

        const after = await prisma.trustedAdultReview.findUnique({ where: { id: reviewId } });
        expect(after!.status).toBe('APPROVED'); // NOT EXPIRED
        expect(await prisma.auditLog.count()).toBe(auditBefore);
    });
});
