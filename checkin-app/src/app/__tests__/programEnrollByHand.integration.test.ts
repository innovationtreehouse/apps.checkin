/**
 * @jest-environment node
 */
/**
 * Enroll by hand: the Board or Finance puts someone in a program without a store
 * payment, recording what the place stands for. Real app DB; the store mirror and
 * the stock push are mocked so each seat change is visible.
 */
import { DELETE, POST } from '@/app/api/programs/[id]/participants/route';
import prisma from '@/lib/prisma';
import { getServerSession } from 'next-auth/next';
import { orderEntitlesEnrollment, type EntitlementOrder } from '@/lib/finance/reconcile/program';
import { activateProgramEnrollment } from '@/lib/programs/activateEnrollment';
import { signCheckout } from '@/lib/programs/checkoutSignature';
import { WITH_EMERGENCY_CONTACT } from '@/test-helpers/emergencyContact';
import type { MirrorOrder } from '@/lib/shopifyRead/client';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));
jest.mock('@/lib/notifications', () => ({ sendNotification: jest.fn() }));
jest.mock('@/lib/email', () => ({
    sendEmail: jest.fn().mockResolvedValue(true),
    runPaced: (tasks: Array<() => Promise<unknown>>) => Promise.all(tasks.map((t) => t())),
}));
jest.mock('@/lib/shopifyRead/client', () => ({
    ...jest.requireActual('@/lib/shopifyRead/client'),
    isConfigured: () => true,
    ordersByLegacyIds: jest.fn(async () => [] as MirrorOrder[]),
    orderLines: jest.fn(async () => [] as { variantId: string; quantity: number; currentQuantity: number }[]),
}));
import * as mirror from '@/lib/shopifyRead/client';
jest.mock('@/lib/shopify/stock', () => ({
    ...jest.requireActual('@/lib/shopify/stock'),
    adjustProgramInventory: jest.fn(async () => true),
    changeProgramStockWith: jest.fn((...a: unknown[]) => jest.requireActual('@/test-helpers/stockWith').forwardStockWith(...a)),
}));
import { adjustProgramInventory } from '@/lib/shopify/stock';

process.env.NEXTAUTH_SECRET ||= 'integration-test-nextauth-secret';

const TAG = 'enroll-by-hand-test';
const VARIANT = `variant-${TAG}`;
const adjust = adjustProgramInventory as jest.Mock;
const ordersByLegacyIds = mirror.ordersByLegacyIds as jest.Mock;
const orderLines = mirror.orderLines as jest.Mock;
const LINE = { variantId: VARIANT, quantity: 1, currentQuantity: 1 };
let nextOrder = 9_100_000;
const newOrderId = () => String(nextOrder++);

function paidOrder(legacyId: string): MirrorOrder {
    return {
        orderGid: `gid://shopify/Order/${legacyId}`, legacyId, customerEmail: null, financialStatus: 'PAID',
        totalCents: 1000, subtotalCents: 1000, totalRefundedCents: 0, discountCents: 0, discountCodes: [],
        cancelledAt: null, processedAt: null, updatedAt: new Date(), lastSyncedAt: new Date(), noteAttributes: null,
    };
}

describe('enroll by hand', () => {
    let programId: number;
    let financeId: number;
    let financeHouseholdId: number;
    let sysadminId: number;
    let boardId: number;
    let n = 0;

    const as = (id: number, flags: Record<string, boolean>) =>
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id, ...flags } });
    const post = async (body: Record<string, unknown>) => {
        const res = await POST(
            new Request(`http://localhost:4000/api/programs/${programId}/participants`, { method: 'POST', body: JSON.stringify(body) }) as unknown as import('next/server').NextRequest,
            { params: Promise.resolve({ id: String(programId) }) } as unknown as never,
        );
        return { status: res.status, data: await res.json() };
    };
    const rowOf = (personId: number) => prisma.programParticipant.findUniqueOrThrow({ where: { programId_personId: { programId, personId } } });

    async function child(householdId?: number): Promise<{ id: number; householdId: number }> {
        return prisma.person.create({
            data: {
                name: `Child ${TAG}`, email: `child-${n++}-${TAG}@example.com`, dateOfBirth: new Date('2015-01-01'),
                ...(householdId ? { householdId } : { household: { create: { name: `HH ${TAG}`, ...WITH_EMERGENCY_CONTACT } } }),
            },
            select: { id: true, householdId: true },
        });
    }
    async function claim(personId: number, held = false): Promise<void> {
        await prisma.programParticipant.create({
            data: {
                programId, personId, status: 'PENDING', pendingSince: new Date(),
                ...(held && { isPaymentPlanRequested: true, inventoryHeldAt: new Date() }),
            },
        });
    }

    beforeAll(async () => {
        financeHouseholdId = (await prisma.household.create({ data: { name: `HH ${TAG}`, ...WITH_EMERGENCY_CONTACT } })).id;
        financeId = (await prisma.person.create({ data: { name: `Finance ${TAG}`, email: `finance-${TAG}@example.com`, householdId: financeHouseholdId } })).id;
        sysadminId = (await prisma.person.create({ data: { name: `Sysadmin ${TAG}`, email: `sysadmin-${TAG}@example.com`, household: { create: { name: `HH ${TAG}` } }, isSysadmin: true } })).id;
        boardId = (await prisma.person.create({ data: { name: `Board ${TAG}`, email: `board-${TAG}@example.com`, household: { create: { name: `HH ${TAG}` } }, isBoardMember: true } })).id;
        programId = (await prisma.program.create({
            data: {
                appliesToYear: 2026, startAt: new Date('2026-01-01'), endAt: new Date('2026-12-31'), name: `Program ${TAG}`,
                phase: 'RUNNING', enrollmentStatus: 'OPEN', offSaleAt: new Date('2999-01-01'), maxParticipants: 20,
                orgMemberPriceCents: 1000, nonOrgMemberPriceCents: 1000, shopifyVariantId: VARIANT,
            },
        })).id;
    });

    beforeEach(() => {
        jest.clearAllMocks();
        ordersByLegacyIds.mockImplementation(async (ids: string[]) => ids.map(paidOrder));
        orderLines.mockResolvedValue([LINE]);
    });

    afterAll(async () => {
        await prisma.paymentException.deleteMany({ where: { programId } });
        await prisma.auditLog.deleteMany({ where: { tableName: 'ProgramParticipant', secondaryAffectedEntity: programId } });
        await prisma.programParticipant.deleteMany({ where: { programId } });
        await prisma.program.delete({ where: { id: programId } });
        const people = await prisma.person.findMany({ where: { email: { endsWith: `${TAG}@example.com` } }, select: { id: true, householdId: true } });
        await prisma.emergencyContact.deleteMany({ where: { householdId: { in: people.map((p) => p.householdId) } } });
        await prisma.person.deleteMany({ where: { id: { in: people.map((p) => p.id) } } });
        await prisma.household.deleteMany({ where: { id: { in: [...new Set(people.map((p) => p.householdId))] } } });
        await prisma.$disconnect();
    });

    it('Finance activates an unpaid place in place, after its sale has ended, recording the basis and the note', async () => {
        const c = await child();
        await claim(c.id);
        await prisma.program.update({ where: { id: programId }, data: { offSaleAt: new Date('2000-01-01') } });
        try {
            as(financeId, { isFinance: true });
            const { status, data } = await post({ participantId: c.id, basis: 'OUTSIDE_PAYMENT', note: 'check 1042' });
            expect(status).toBe(200);
            expect(data.enrollment).toMatchObject({ status: 'ACTIVE', enrollmentBasis: 'OUTSIDE_PAYMENT', shopifyOrderId: null, pendingSince: null });
        } finally {
            await prisma.program.update({ where: { id: programId }, data: { offSaleAt: new Date('2999-01-01') } });
        }
        const row = await rowOf(c.id);
        expect(row.seatTakenWithoutSaleAt).not.toBeNull();
        expect(adjust).toHaveBeenCalledWith(expect.anything(), -1, expect.anything(), expect.anything());
        const audit = await prisma.auditLog.findFirst({ where: { tableName: 'ProgramParticipant', affectedEntityId: c.id, secondaryAffectedEntity: programId, action: 'EDIT' } });
        expect(audit?.actorId).toBe(financeId);
        expect(audit?.newData).toMatchObject({ enrollmentBasis: 'OUTSIDE_PAYMENT', note: 'check 1042' });
    });

    it('refuses a Finance member enrolling their own household without payment', async () => {
        const c = await child(financeHouseholdId);
        await claim(c.id);
        as(financeId, { isFinance: true });
        const { status, data } = await post({ participantId: c.id, basis: 'COMP' });
        expect(status).toBe(403);
        expect(data.error).toMatch(/own household/);
        expect((await rowOf(c.id)).status).toBe('PENDING');
    });

    it('a sysadmin can no longer comp; with an override and no basis the place waits for payment', async () => {
        const c = await child();
        as(sysadminId, { isSysadmin: true });
        expect((await post({ participantId: c.id, basis: 'COMP', override: true })).status).toBe(403);
        const { status, data } = await post({ participantId: c.id, override: true });
        expect(status).toBe(200);
        expect(data.enrollment.status).toBe('PENDING');
    });

    it('the Board enrolls someone not yet on the roster as a comp', async () => {
        const c = await child();
        as(boardId, { isBoardMember: true });
        const { status, data } = await post({ participantId: c.id, basis: 'COMP', override: true });
        expect(status).toBe(200);
        expect(data.enrollment).toMatchObject({ status: 'ACTIVE', enrollmentBasis: 'COMP' });
        expect((await rowOf(c.id)).seatTakenWithoutSaleAt).not.toBeNull();
    });

    it('a store order matched by hand is spent: the same order is not raised as a duplicate later', async () => {
        const c = await child();
        await claim(c.id);
        const oid = newOrderId();
        as(financeId, { isFinance: true });
        const { status, data } = await post({ participantId: c.id, basis: 'MATCHED_ORDER', shopifyOrderId: oid });
        expect(status).toBe(200);
        expect(data.enrollment).toMatchObject({ status: 'ACTIVE', enrollmentBasis: 'MATCHED_ORDER', shopifyOrderId: oid });
        expect(adjust).not.toHaveBeenCalled(); // the sale took its own unit

        const later: EntitlementOrder = { ...paidOrder(oid), lines: [LINE], checkoutSig: signCheckout(programId, [c.id], c.householdId) };
        const verdict = await orderEntitlesEnrollment(later, programId, [c.id]);
        expect(verdict).toEqual({ ok: false, kind: null, personId: undefined, nothingAwaiting: true });
    });

    it('a store order for someone already enrolled as paid outside the store IS raised as a duplicate', async () => {
        const c = await child();
        await claim(c.id);
        as(financeId, { isFinance: true });
        expect((await post({ participantId: c.id, basis: 'OUTSIDE_PAYMENT' })).status).toBe(200);

        const order: EntitlementOrder = { ...paidOrder(newOrderId()), lines: [LINE], checkoutSig: signCheckout(programId, [c.id], c.householdId) };
        const verdict = await orderEntitlesEnrollment(order, programId, [c.id]);
        expect(verdict).toMatchObject({ ok: false, kind: 'DUPLICATE_PAYMENT', personId: c.id });
    });

    it('refuses to match an order whose seat already went to someone else', async () => {
        const a = await child();
        const b = await child(a.householdId);
        await claim(a.id);
        await claim(b.id);
        const oid = newOrderId();
        await activateProgramEnrollment({ programId, personIds: [a.id], shopifyOrderId: oid, lines: [LINE] });

        as(financeId, { isFinance: true });
        const { status } = await post({ participantId: b.id, basis: 'MATCHED_ORDER', shopifyOrderId: oid });
        expect(status).toBe(409);
        expect((await rowOf(b.id)).status).toBe('PENDING');
    });

    it("refuses to spend an order the app's checkout made for someone else", async () => {
        const a = await child();
        const b = await child(a.householdId);
        await claim(a.id, true);
        await claim(b.id);
        const oid = newOrderId();
        ordersByLegacyIds.mockImplementation(async (ids: string[]) => ids.map((id) => ({
            ...paidOrder(id),
            noteAttributes: [{ key: 'Program_ID', value: String(programId) }, { key: 'CheckMeIn_Account_ID', value: String(a.id) }],
        })));

        as(financeId, { isFinance: true });
        const { status, data } = await post({ participantId: b.id, basis: 'MATCHED_ORDER', shopifyOrderId: oid });
        expect(status).toBe(409);
        expect(data.error).toMatch(/someone besides this person/);
        expect((await rowOf(b.id)).status).toBe('PENDING');
    });

    it('does not let an order re-seat a person it already paid for, who left and came back', async () => {
        const a = await child();
        const b = await child(a.householdId);
        await claim(a.id);
        await claim(b.id);
        const oid = newOrderId();
        await activateProgramEnrollment({ programId, personIds: [a.id], shopifyOrderId: oid, lines: [{ ...LINE, quantity: 2, currentQuantity: 2 }] });
        // a is removed (the audit keeps the order) and enrolls again.
        await prisma.programParticipant.delete({ where: { programId_personId: { programId, personId: a.id } } });
        await prisma.auditLog.create({ data: { actorId: boardId, action: 'DELETE', tableName: 'ProgramParticipant', affectedEntityId: a.id, secondaryAffectedEntity: programId, oldData: { programId, personId: a.id, status: 'ACTIVE', shopifyOrderId: oid } } });
        await claim(a.id);
        orderLines.mockResolvedValue([{ ...LINE, quantity: 2, currentQuantity: 2 }]);

        as(financeId, { isFinance: true });
        expect((await post({ participantId: a.id, basis: 'MATCHED_ORDER', shopifyOrderId: oid })).status).toBe(409);
        const replay = await activateProgramEnrollment({ programId, personIds: [a.id], shopifyOrderId: oid, lines: [{ ...LINE, quantity: 2, currentQuantity: 2 }] });
        expect(replay.activatedCount).toBe(0);
        expect((await post({ participantId: b.id, basis: 'MATCHED_ORDER', shopifyOrderId: oid })).status).toBe(200);
        expect((await rowOf(a.id)).status).toBe('PENDING');
    });

    it('refuses to enroll by hand a claim whose household was archived', async () => {
        const c = await child();
        await claim(c.id);
        await prisma.household.update({ where: { id: c.householdId }, data: { archivedAt: new Date() } });
        as(financeId, { isFinance: true });
        expect((await post({ participantId: c.id, basis: 'OUTSIDE_PAYMENT' })).status).toBe(409);
        expect((await rowOf(c.id)).status).toBe('PENDING');
    });

    it('refuses a basis on a free program', async () => {
        const c = await child();
        await prisma.program.update({ where: { id: programId }, data: { orgMemberPriceCents: null, nonOrgMemberPriceCents: null } });
        try {
            as(boardId, { isBoardMember: true });
            expect((await post({ participantId: c.id, basis: 'COMP' })).status).toBe(400);
        } finally {
            await prisma.program.update({ where: { id: programId }, data: { orgMemberPriceCents: 1000, nonOrgMemberPriceCents: 1000 } });
        }
    });

    it('keeps a place paid outside the store paid when the price is later zeroed', async () => {
        const c = await child();
        await claim(c.id);
        as(financeId, { isFinance: true });
        expect((await post({ participantId: c.id, basis: 'OUTSIDE_PAYMENT' })).status).toBe(200);
        await prisma.program.update({ where: { id: programId }, data: { orgMemberPriceCents: null, nonOrgMemberPriceCents: null } });
        try {
            as(sysadminId, { isSysadmin: true });
            const res = await DELETE(
                new Request(`http://localhost:4000/api/programs/${programId}/participants`, { method: 'DELETE', body: JSON.stringify({ participantId: c.id }) }) as unknown as import('next/server').NextRequest,
                { params: Promise.resolve({ id: String(programId) }) } as unknown as never,
            );
            expect(res.status).toBe(403);
            expect((await rowOf(c.id)).status).toBe('ACTIVE');
        } finally {
            await prisma.program.update({ where: { id: programId }, data: { orgMemberPriceCents: 1000, nonOrgMemberPriceCents: 1000 } });
        }
    });

    describe.each([
        ['OUTSIDE_PAYMENT', 0, true],
        ['COMP', 0, true],
        ['MATCHED_ORDER', 1, false],
    ] as const)('a held scholarship seat enrolled by hand as %s', (basis, release, stamped) => {
        it('is given back exactly once, and a later store payment gives back nothing', async () => {
            const c = await child();
            await claim(c.id, true);
            as(financeId, { isFinance: true });
            const oid = newOrderId();
            const { status, data } = await post({ participantId: c.id, basis, ...(basis === 'MATCHED_ORDER' && { shopifyOrderId: oid }) });
            expect(status).toBe(200);
            expect(data.enrollment.inventoryHeldAt).toBeNull();
            expect(data.enrollment.seatTakenWithoutSaleAt !== null).toBe(stamped);
            expect(adjust.mock.calls.map((call) => call[1])).toEqual(release ? [release] : []);

            adjust.mockClear();
            const webhook = await activateProgramEnrollment({ programId, personIds: [c.id], shopifyOrderId: newOrderId(), lines: [LINE] });
            expect(webhook).toMatchObject({ activatedCount: 0, releasedHoldCount: 0 });
            expect(adjust).not.toHaveBeenCalled();
        });
    });
});
