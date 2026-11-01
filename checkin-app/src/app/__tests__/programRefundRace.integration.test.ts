/**
 * @jest-environment node
 */
/**
 * A refund recorded while activation is running: the two serialize on the order,
 * so either activation refuses the order or the refund finds the activated place.
 * Runs the real stock writer, whose program lock is part of the interleaving.
 */
import { activateProgramEnrollment } from '@/lib/programs/activateEnrollment';
import { raiseReversalByOrderId } from '@/lib/finance/reconcile/reversals';
import prisma from '@/lib/prisma';
import { Client } from 'pg';

jest.mock('@/lib/email', () => ({
    sendEmail: jest.fn().mockResolvedValue(true),
    runPaced: (tasks: Array<() => Promise<unknown>>) => Promise.all(tasks.map((t) => t())),
}));

const TAG = 'program-refund-race-test';
const VARIANT = `variant-${TAG}`;
const orderId = (label: string) => `${TAG}-${label}-${Math.random().toString(36).slice(2)}`;
const settle = () => new Promise((r) => setTimeout(r, 1_000));

/** Holds a row lock on a connection outside the app's pool; the returned function releases it. */
async function holdLock(sql: string, params: number[]) {
    const holder = new Client({ connectionString: process.env.DATABASE_URL });
    await holder.connect();
    await holder.query('BEGIN');
    await holder.query(sql, params);
    return async () => {
        await holder.query('COMMIT');
        await holder.end();
    };
}

describe('a refund recorded during activation', () => {
    let programId: number;
    let householdId: number;
    let nextPerson = 0;

    async function pendingChild(): Promise<number> {
        const p = await prisma.person.create({ data: { name: `Child ${TAG}`, email: `child-${nextPerson++}-${TAG}@example.com`, householdId } });
        await prisma.programParticipant.create({ data: { programId, personId: p.id, status: 'PENDING', pendingSince: new Date() } });
        return p.id;
    }
    const statusOf = async (personId: number) =>
        (await prisma.programParticipant.findUniqueOrThrow({ where: { programId_personId: { programId, personId } } })).status;

    beforeAll(async () => {
        householdId = (await prisma.household.create({ data: { name: `HH ${TAG}` } })).id;
        await prisma.person.create({ data: { name: `Board ${TAG}`, email: `board-${TAG}@example.com`, isBoardMember: true, householdId } });
        programId = (await prisma.program.create({
            data: { appliesToYear: 2026, startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: `Program ${TAG}`, enrollmentStatus: 'OPEN', offSaleAt: new Date('2999-01-01'), shopifyVariantId: VARIANT, maxParticipants: 2 },
        })).id;
    });

    afterAll(async () => {
        await prisma.paymentException.deleteMany({ where: { shopifyOrderId: { startsWith: `${TAG}-` } } });
        await prisma.auditLog.deleteMany({ where: { tableName: 'ShopifyOrderReversal', newData: { path: ['shopifyOrderId'], string_starts_with: `${TAG}-` } } });
        await prisma.programParticipant.deleteMany({ where: { programId } });
        await prisma.program.delete({ where: { id: programId } });
        await prisma.person.deleteMany({ where: { householdId } });
        await prisma.household.delete({ where: { id: householdId } });
        await prisma.$disconnect();
    });

    it('recorded before the flips: the place stays pending and the Board hears CRITICAL', async () => {
        const oid = orderId('before-flips');
        const child = await pendingChild();
        const releaseProgram = await holdLock('SELECT id FROM "Program" WHERE id = $1 FOR UPDATE', [programId]);

        const activation = activateProgramEnrollment({ programId, personIds: [child], shopifyOrderId: oid, lines: [{ variantId: VARIANT, quantity: 1 }] });
        await settle();
        await raiseReversalByOrderId(oid, 'REFUND');
        await releaseProgram();

        expect(await activation).toEqual({ activatedCount: 0, releasedHoldCount: 0, claimantSeatCount: 0, reversed: true });
        expect(await statusOf(child)).toBe('PENDING');
        expect(await prisma.paymentException.findMany({ where: { shopifyOrderId: oid } })).toEqual([
            expect.objectContaining({ kind: 'REVERSED_BEFORE_ACTIVATION', severity: 'CRITICAL', programId, personId: child }),
        ]);
    });

    it('arriving after the check: the refund waits for the flips, then finds the place', async () => {
        const oid = orderId('after-check');
        const child = await pendingChild();
        const releaseRow = await holdLock('SELECT 1 FROM "ProgramParticipant" WHERE "programId" = $1 AND "personId" = $2 FOR UPDATE', [programId, child]);

        const activation = activateProgramEnrollment({ programId, personIds: [child], shopifyOrderId: oid, lines: [{ variantId: VARIANT, quantity: 1 }] });
        await settle();
        let finished = false;
        const refund = raiseReversalByOrderId(oid, 'REFUND').then((matched) => { finished = true; return matched; });
        await settle();
        expect(finished).toBe(false);
        await releaseRow();

        expect((await activation).activatedCount).toBe(1);
        expect(await refund).toBe(true);
        expect(await statusOf(child)).toBe('ACTIVE');
        expect(await prisma.paymentException.findMany({ where: { shopifyOrderId: oid } })).toEqual([
            expect.objectContaining({ kind: 'REFUND', programId, personId: child }),
        ]);
    });
});
