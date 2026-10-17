/**
 * @jest-environment node
 */
/**
 * Unit tests for the bidirectional match audit's BUCKETING — the part where a
 * wrong branch sends the board chasing the wrong money. Prisma and the mirror
 * are both stubbed at the module boundary (house pattern); the mirror SQL is
 * covered in lib/shopifyRead/__tests__/client.test.ts.
 */
import { runMatchAudit } from '../matchAudit';

const prismaMock = {
    boardSettings: { findUnique: jest.fn() },
    program: { findMany: jest.fn() },
    orgMembershipProcess: { findMany: jest.fn() },
    programParticipant: { findMany: jest.fn() },
    paymentException: { findMany: jest.fn() },
    person: { findMany: jest.fn() },
    auditLog: { findMany: jest.fn() },
    orgMembership: { findMany: jest.fn() },
};
// The factories defer every dereference to call time (jest.mock is hoisted above
// the consts, so touching them during factory evaluation would hit the TDZ).
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        boardSettings: { findUnique: (...a: unknown[]) => prismaMock.boardSettings.findUnique(...a) },
        program: { findMany: (...a: unknown[]) => prismaMock.program.findMany(...a) },
        orgMembershipProcess: { findMany: (...a: unknown[]) => prismaMock.orgMembershipProcess.findMany(...a) },
        programParticipant: { findMany: (...a: unknown[]) => prismaMock.programParticipant.findMany(...a) },
        paymentException: { findMany: (...a: unknown[]) => prismaMock.paymentException.findMany(...a) },
        person: { findMany: (...a: unknown[]) => prismaMock.person.findMany(...a) },
        auditLog: { findMany: (...a: unknown[]) => prismaMock.auditLog.findMany(...a) },
        orgMembership: { findMany: (...a: unknown[]) => prismaMock.orgMembership.findMany(...a) },
    },
}));

const mirrorMock = {
    isConfigured: jest.fn(),
    lineVariantStats: jest.fn(),
    ordersForVariants: jest.fn(),
    orderLegacyIdsPresent: jest.fn(),
    ordersByLegacyIds: jest.fn(),
    minRealOrderLegacyId: jest.fn(),
};
jest.mock('@/lib/shopifyRead/client', () => ({
    isConfigured: () => mirrorMock.isConfigured(),
    lineVariantStats: () => mirrorMock.lineVariantStats(),
    ordersForVariants: (...a: unknown[]) => mirrorMock.ordersForVariants(...a),
    orderLegacyIdsPresent: (...a: unknown[]) => mirrorMock.orderLegacyIdsPresent(...a),
    ordersByLegacyIds: (...a: unknown[]) => mirrorMock.ordersByLegacyIds(...a),
    minRealOrderLegacyId: () => mirrorMock.minRealOrderLegacyId(),
}));

const paidOrder = (legacyId: string, over: Partial<Record<string, unknown>> = {}) => ({
    legacyId,
    name: `#${legacyId}`,
    customerEmail: 'buyer@example.com',
    financialStatus: 'PAID',
    totalCents: 5000,
    totalRefundedCents: 0,
    cancelledAt: null,
    matchedVariantIds: ['111'],
    ...over,
});

beforeEach(() => {
    jest.clearAllMocks();
    mirrorMock.isConfigured.mockReturnValue(true);
    mirrorMock.lineVariantStats.mockResolvedValue({ lines: 10, withVariant: 10 });
    mirrorMock.ordersForVariants.mockResolvedValue([]);
    mirrorMock.orderLegacyIdsPresent.mockResolvedValue(new Set());
    prismaMock.boardSettings.findUnique.mockResolvedValue({
        orgMembershipVariantId: '111',
    });
    prismaMock.program.findMany.mockResolvedValue([
        { id: 7, name: 'Robotics', shopifyVariantId: '222' },
    ]);
    prismaMock.orgMembershipProcess.findMany.mockResolvedValue([]);
    prismaMock.programParticipant.findMany.mockResolvedValue([]);
    prismaMock.paymentException.findMany.mockResolvedValue([]);
    prismaMock.person.findMany.mockResolvedValue([]);
    prismaMock.auditLog.findMany.mockResolvedValue([]);
    prismaMock.orgMembership.findMany.mockResolvedValue([]);
    mirrorMock.ordersByLegacyIds.mockResolvedValue([]);
    mirrorMock.minRealOrderLegacyId.mockResolvedValue(null);
});

it('reports configured:false without touching prisma or the mirror data when unwired', async () => {
    mirrorMock.isConfigured.mockReturnValue(false);
    const r = await runMatchAudit();
    expect(r.configured).toBe(false);
    expect(mirrorMock.ordersForVariants).not.toHaveBeenCalled();
});

it('asks the mirror for exactly the union of settings + program variants', async () => {
    await runMatchAudit();
    const asked = mirrorMock.ordersForVariants.mock.calls[0][0] as string[];
    expect([...asked].sort()).toEqual(['111', '222']);
});

describe('order buckets (Shopify → activation)', () => {
    it('claimed by a membership process → MATCHED', async () => {
        mirrorMock.ordersForVariants.mockResolvedValue([paidOrder('900')]);
        // First orgMembershipProcess.findMany call is the claim lookup; second is the activation sweep.
        prismaMock.orgMembershipProcess.findMany
            .mockResolvedValueOnce([{ shopifyOrderId: '900' }])
            .mockResolvedValueOnce([]);
        const r = await runMatchAudit();
        expect(r.orders[0].bucket).toBe('MATCHED');
    });

    it('unclaimed but already tracked by an unresolved PaymentException → TRACKED_EXCEPTION, not a new gap', async () => {
        mirrorMock.ordersForVariants.mockResolvedValue([paidOrder('901')]);
        prismaMock.paymentException.findMany.mockResolvedValue([{ shopifyOrderId: '901' }]);
        const r = await runMatchAudit();
        expect(r.orders[0].bucket).toBe('TRACKED_EXCEPTION');
    });

    it('paid, variant-matched, claimed by nothing → UNCLAIMED_PAID (the gap), naming what it should have bought', async () => {
        mirrorMock.ordersForVariants.mockResolvedValue([paidOrder('902', { matchedVariantIds: ['111', '222'] })]);
        const r = await runMatchAudit();
        expect(r.orders[0].bucket).toBe('UNCLAIMED_PAID');
        expect(r.orders[0].expected.sort()).toEqual(['membership', 'program: Robotics']);
    });

    it('unclaimed but refunded/cancelled/pending → UNCLAIMED_UNPAID (informational, not the paid gap)', async () => {
        mirrorMock.ordersForVariants.mockResolvedValue([
            paidOrder('903', { totalRefundedCents: 5000, financialStatus: 'REFUNDED' }),
            paidOrder('904', { financialStatus: 'PENDING' }),
        ]);
        const r = await runMatchAudit();
        expect(r.orders.map((o) => o.bucket)).toEqual(['UNCLAIMED_UNPAID', 'UNCLAIMED_UNPAID']);
    });

    it('splits a multi-item checkout per kind: membership claimed, program half not → UNCLAIMED_PAID naming only the gap', async () => {
        mirrorMock.ordersForVariants.mockResolvedValue([paidOrder('905', { matchedVariantIds: ['111', '222'] })]);
        prismaMock.orgMembershipProcess.findMany
            .mockResolvedValueOnce([{ shopifyOrderId: '905' }]) // claims the MEMBERSHIP half only
            .mockResolvedValueOnce([]);
        const r = await runMatchAudit();
        expect(r.orders[0].bucket).toBe('UNCLAIMED_PAID');
        expect(r.orders[0].expected).toEqual(['program: Robotics']);
    });

    it('a program enrollment claims its own program half → MATCHED', async () => {
        mirrorMock.ordersForVariants.mockResolvedValue([paidOrder('906', { matchedVariantIds: ['222'] })]);
        prismaMock.programParticipant.findMany
            .mockResolvedValueOnce([{ shopifyOrderId: '906', programId: 7 }]) // claim lookup
            .mockResolvedValueOnce([]); // activation sweep
        const r = await runMatchAudit();
        expect(r.orders[0].bucket).toBe('MATCHED');
    });

    it('neither an ARCHIVED nor a BLOCKED process is a claim — the lookup excludes both in the where', async () => {
        await runMatchAudit();
        const claimWhere = (prismaMock.orgMembershipProcess.findMany.mock.calls[0][0] as { where: { status: unknown } }).where;
        expect(claimWhere.status).toEqual({ notIn: ['ARCHIVED', 'BLOCKED'] });
    });

    it('paid-while-blocked: claim excluded, the open exception (processId-attributed) buckets it TRACKED_EXCEPTION', async () => {
        mirrorMock.ordersForVariants.mockResolvedValue([paidOrder('911')]);
        // The BLOCKED process's PAID_WHILE_BLOCKED exception is open and carries processId;
        // the claim lookup's notIn keeps the BLOCKED process itself out of the claim set.
        prismaMock.paymentException.findMany.mockResolvedValue([{ shopifyOrderId: '911', processId: 55, programId: null }]);
        const r = await runMatchAudit();
        expect(r.orders[0].bucket).toBe('TRACKED_EXCEPTION');
    });

    it('a kind-attributed exception covers only ITS half: tracked membership + untracked program → UNCLAIMED_PAID naming the program', async () => {
        mirrorMock.ordersForVariants.mockResolvedValue([paidOrder('908', { matchedVariantIds: ['111', '222'] })]);
        prismaMock.paymentException.findMany.mockResolvedValue([{ shopifyOrderId: '908', processId: 55, programId: null }]);
        const r = await runMatchAudit();
        expect(r.orders[0].bucket).toBe('UNCLAIMED_PAID');
        expect(r.orders[0].expected).toEqual(['program: Robotics']);
    });

    it('an order-level exception (no process/program attribution) covers the whole order → TRACKED_EXCEPTION', async () => {
        mirrorMock.ordersForVariants.mockResolvedValue([paidOrder('909', { matchedVariantIds: ['111', '222'] })]);
        prismaMock.paymentException.findMany.mockResolvedValue([{ shopifyOrderId: '909', processId: null, programId: null }]);
        const r = await runMatchAudit();
        expect(r.orders[0].bucket).toBe('TRACKED_EXCEPTION');
    });

    it('a fully-claimed order stays MATCHED even when refunded (claim precedence — reversal-pass territory)', async () => {
        mirrorMock.ordersForVariants.mockResolvedValue([paidOrder('907', { totalRefundedCents: 5000, financialStatus: 'REFUNDED' })]);
        prismaMock.orgMembershipProcess.findMany
            .mockResolvedValueOnce([{ shopifyOrderId: '907' }])
            .mockResolvedValueOnce([]);
        const r = await runMatchAudit();
        expect(r.orders[0].bucket).toBe('MATCHED');
    });
});

describe('membership buckets (activation → Shopify)', () => {
    const proc = (id: number, over: Partial<Record<string, unknown>> = {}) => ({
        id,
        shopifyOrderId: null,
        manualPaymentById: null,
        orgMembership: { household: { name: `House ${id}` } },
        ...over,
    });

    it('classifies all four buckets, resolving manual-payment actor names', async () => {
        prismaMock.orgMembershipProcess.findMany
            .mockResolvedValueOnce([]) // claim lookup
            .mockResolvedValueOnce([
                proc(1, { shopifyOrderId: '800' }),
                proc(2, { shopifyOrderId: '801' }),
                proc(3, { manualPaymentById: 42 }),
                proc(4),
            ]);
        mirrorMock.orderLegacyIdsPresent.mockResolvedValue(new Set(['800']));
        prismaMock.person.findMany.mockResolvedValue([{ id: 42, name: 'Board Bob' }]);

        const r = await runMatchAudit();
        expect(r.memberships.map((m) => m.bucket)).toEqual([
            'ORDER_MATCHED',
            'ORDER_NOT_IN_MIRROR',
            'MANUAL_PAYMENT',
            'NO_PAYMENT_BASIS',
        ]);
        expect(r.memberships[2].manualPaymentByName).toBe('Board Bob');
    });

    it('sweeps only payment-bearing kinds — PERSON_BG processes must never appear as gaps', async () => {
        await runMatchAudit();
        const sweep = prismaMock.orgMembershipProcess.findMany.mock.calls[1][0];
        expect(sweep.where.kind).toEqual({ in: ['INITIAL', 'RENEWAL'] });
        expect(sweep.where.status).toEqual({ in: ['ACTIVE', 'PENDING_BG_CLEARANCE'] });
    });

    it('reversed after activation → ORDER_REVERSED, not a fresh gap', async () => {
        prismaMock.orgMembershipProcess.findMany
            .mockResolvedValueOnce([]) // claim lookup
            .mockResolvedValueOnce([proc(1, { shopifyOrderId: '800' })]);
        mirrorMock.orderLegacyIdsPresent.mockResolvedValue(new Set(['800']));
        mirrorMock.ordersByLegacyIds.mockResolvedValue([
            { legacyId: '800', financialStatus: 'REFUNDED', totalRefundedCents: 5000, cancelledAt: null },
        ]);

        const r = await runMatchAudit();
        expect(r.memberships[0].bucket).toBe('ORDER_REVERSED');
    });

    it('an ACTIVE household membership with no INITIAL/RENEWAL process → NO_PROCESS gap', async () => {
        prismaMock.orgMembership.findMany.mockResolvedValue([{ id: 5, household: { name: 'The Finches' } }]);

        const r = await runMatchAudit();
        expect(r.memberships).toContainEqual(
            expect.objectContaining({ bucket: 'NO_PROCESS', processId: null, membershipId: 5, householdName: 'The Finches' }),
        );
    });

    it('NO_PROCESS sweep asks for exactly the pinned where', async () => {
        await runMatchAudit();
        expect(prismaMock.orgMembership.findMany.mock.calls[0][0].where).toEqual({
            status: 'ACTIVE',
            processes: { none: { kind: { in: ['INITIAL', 'RENEWAL'] }, status: { not: 'ARCHIVED' } } },
        });
    });
});

describe('PRE_MIRROR vs ORDER_NOT_IN_MIRROR', () => {
    const proc = (id: number, shopifyOrderId: string) => ({
        id,
        shopifyOrderId,
        manualPaymentById: null,
        orgMembership: { household: { name: `House ${id}` } },
    });

    it('an id below the mirror low-water mark is PRE_MIRROR; at/above it is a real gap', async () => {
        prismaMock.orgMembershipProcess.findMany
            .mockResolvedValueOnce([]) // claim lookup
            .mockResolvedValueOnce([proc(1, '50'), proc(2, '200')]);
        mirrorMock.orderLegacyIdsPresent.mockResolvedValue(new Set());
        mirrorMock.minRealOrderLegacyId.mockResolvedValue(BigInt(100));

        const r = await runMatchAudit();
        expect(r.memberships.map((m) => m.bucket)).toEqual(['PRE_MIRROR', 'ORDER_NOT_IN_MIRROR']);
    });

    it('an empty mirror (null low-water mark) never reclassifies — everything is a real gap', async () => {
        prismaMock.orgMembershipProcess.findMany
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([proc(1, '50'), proc(2, '200')]);
        mirrorMock.orderLegacyIdsPresent.mockResolvedValue(new Set());
        mirrorMock.minRealOrderLegacyId.mockResolvedValue(null);

        const r = await runMatchAudit();
        expect(r.memberships.map((m) => m.bucket)).toEqual(['ORDER_NOT_IN_MIRROR', 'ORDER_NOT_IN_MIRROR']);
    });
});

describe('enrollment buckets', () => {
    const enroll = (personId: number, over: Partial<Record<string, unknown>> = {}) => ({
        programId: 7,
        personId,
        shopifyOrderId: null,
        wasOrgMemberAtApproval: null,
        program: { name: 'Robotics' },
        person: { name: `Kid ${personId}` },
        ...over,
    });

    it('order-backed, scholarship-approved, and basis-less enrollments land in their buckets', async () => {
        prismaMock.programParticipant.findMany
            .mockResolvedValueOnce([]) // claim lookup
            .mockResolvedValueOnce([
                enroll(1, { shopifyOrderId: '700' }),
                enroll(2, { wasOrgMemberAtApproval: true }),
                enroll(3),
            ]);
        mirrorMock.orderLegacyIdsPresent.mockResolvedValue(new Set(['700']));

        const r = await runMatchAudit();
        expect(r.enrollments.map((e) => e.bucket)).toEqual(['ORDER_MATCHED', 'SCHOLARSHIP_APPROVED', 'NO_PAYMENT_BASIS']);
    });

    it('reversed after activation → ORDER_REVERSED, not a fresh gap', async () => {
        prismaMock.programParticipant.findMany
            .mockResolvedValueOnce([]) // claim lookup
            .mockResolvedValueOnce([enroll(1, { shopifyOrderId: '700' })]);
        mirrorMock.orderLegacyIdsPresent.mockResolvedValue(new Set(['700']));
        mirrorMock.ordersByLegacyIds.mockResolvedValue([
            { legacyId: '700', financialStatus: 'PAID', totalRefundedCents: 0, cancelledAt: new Date() },
        ]);

        const r = await runMatchAudit();
        expect(r.enrollments[0].bucket).toBe('ORDER_REVERSED');
    });

    it('sweeps only payment-bearing programs — a free program never floods NO_PAYMENT_BASIS', async () => {
        await runMatchAudit();
        const sweep = prismaMock.programParticipant.findMany.mock.calls[1][0];
        expect(sweep.where.status).toBe('ACTIVE');
        expect(sweep.where.OR).toContainEqual({ shopifyOrderId: { not: null } });
        expect(sweep.where.OR).toContainEqual({ program: { shopifyVariantId: { not: null } } });
    });

    describe('ADMIN_COMPED', () => {
        it('an enrollment CREATED active with no order and no scholarship stamp → ADMIN_COMPED', async () => {
            prismaMock.programParticipant.findMany
                .mockResolvedValueOnce([]) // claim lookup
                .mockResolvedValueOnce([enroll(3)]);
            prismaMock.auditLog.findMany.mockResolvedValue([
                { affectedEntityId: 3, secondaryAffectedEntity: 7, actorId: 42, newData: { status: 'ACTIVE' } },
            ]);
            prismaMock.person.findMany.mockResolvedValue([{ id: 42, name: 'Admin Amy' }]);

            const r = await runMatchAudit();
            expect(r.enrollments[0].bucket).toBe('ADMIN_COMPED');
            expect(r.enrollments[0].compedByName).toBe('Admin Amy');
        });

        it('created PENDING (later flipped some other way) stays NO_PAYMENT_BASIS — proves the inference', async () => {
            prismaMock.programParticipant.findMany
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([enroll(3)]);
            prismaMock.auditLog.findMany.mockResolvedValue([
                { affectedEntityId: 3, secondaryAffectedEntity: 7, actorId: 42, newData: { status: 'PENDING' } },
            ]);

            const r = await runMatchAudit();
            expect(r.enrollments[0].bucket).toBe('NO_PAYMENT_BASIS');
            expect(r.enrollments[0].compedByName).toBeNull();
        });

        it('looks up the CREATE audit row in one batched query with the pinned where', async () => {
            prismaMock.programParticipant.findMany
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([enroll(3)]);
            prismaMock.auditLog.findMany.mockResolvedValue([
                { affectedEntityId: 3, secondaryAffectedEntity: 7, actorId: 42, newData: { status: 'ACTIVE' } },
            ]);
            prismaMock.person.findMany.mockResolvedValue([{ id: 42, name: 'Admin Amy' }]);

            await runMatchAudit();
            expect(prismaMock.auditLog.findMany).toHaveBeenCalledTimes(1);
            const where = prismaMock.auditLog.findMany.mock.calls[0][0].where;
            expect(where.tableName).toBe('ProgramParticipant');
            expect(where.action).toBe('CREATE');
            expect(where.affectedEntityId).toEqual({ in: [3] });
            expect(where.secondaryAffectedEntity).toEqual({ in: [7] });
        });
    });
});

describe('tracked-exception override (P3 gap → exception promotion)', () => {
    const proc = (id: number, over: Partial<Record<string, unknown>> = {}) => ({
        id,
        shopifyOrderId: null,
        manualPaymentById: null,
        orgMembership: { household: { name: `House ${id}` } },
        ...over,
    });
    const enroll = (personId: number, over: Partial<Record<string, unknown>> = {}) => ({
        programId: 7,
        personId,
        shopifyOrderId: null,
        wasOrgMemberAtApproval: null,
        program: { name: 'Robotics' },
        person: { name: `Kid ${personId}` },
        ...over,
    });
    // Distinguishes the three paymentException.findMany call sites (order-side
    // trackedExceptions, membership tracked lookup, enrollment tracked lookup) by
    // their where-clause shape, since all three share one jest.fn().
    const isMembershipLookup = (where: Record<string, unknown>) => 'processId' in where;
    const isEnrollmentLookup = (where: Record<string, unknown>) => 'programId' in where && !('shopifyOrderId' in where);

    it('a NO_PAYMENT_BASIS membership with an open exception on its processId → TRACKED_EXCEPTION, not a gap', async () => {
        prismaMock.orgMembershipProcess.findMany
            .mockResolvedValueOnce([]) // claim lookup
            .mockResolvedValueOnce([proc(1)]);
        prismaMock.paymentException.findMany.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
            isMembershipLookup(where) ? [{ processId: 1 }] : [],
        );
        const r = await runMatchAudit();
        expect(r.memberships[0].bucket).toBe('TRACKED_EXCEPTION');
    });

    it('a NO_PAYMENT_BASIS enrollment with an open exception on its (programId, personId) → TRACKED_EXCEPTION, not a gap', async () => {
        prismaMock.programParticipant.findMany
            .mockResolvedValueOnce([]) // claim lookup
            .mockResolvedValueOnce([enroll(3)]);
        prismaMock.paymentException.findMany.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
            isEnrollmentLookup(where) ? [{ programId: 7, personId: 3 }] : [],
        );
        const r = await runMatchAudit();
        expect(r.enrollments[0].bucket).toBe('TRACKED_EXCEPTION');
    });

    it('the tracked lookups exclude RESOLVED exceptions by construction (a RESOLVED row must not flip the bucket)', async () => {
        prismaMock.orgMembershipProcess.findMany
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([proc(1)]);
        prismaMock.programParticipant.findMany
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([enroll(3)]);
        await runMatchAudit();
        const calls = prismaMock.paymentException.findMany.mock.calls as [{ where: Record<string, unknown> }][];
        const membershipCall = calls.find(([{ where }]) => isMembershipLookup(where));
        const enrollmentCall = calls.find(([{ where }]) => isEnrollmentLookup(where));
        expect(membershipCall![0].where.status).toEqual({ not: 'RESOLVED' });
        expect(enrollmentCall![0].where.status).toEqual({ not: 'RESOLVED' });
    });

    it('a stray open exception on a MANUAL_PAYMENT row is not overridden — the override is gap-only', async () => {
        prismaMock.orgMembershipProcess.findMany
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([proc(1, { manualPaymentById: 42 })]); // MANUAL_PAYMENT, not a gap
        prismaMock.person.findMany.mockResolvedValue([{ id: 42, name: 'Board Bob' }]);
        prismaMock.paymentException.findMany.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
            isMembershipLookup(where) ? [{ processId: 1 }] : [],
        );
        const r = await runMatchAudit();
        expect(r.memberships[0].bucket).toBe('MANUAL_PAYMENT');
    });

    it('a stray open exception on an ORDER_MATCHED enrollment is not overridden — the override is gap-only', async () => {
        prismaMock.programParticipant.findMany
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([enroll(3, { shopifyOrderId: '700' })]); // ORDER_MATCHED, not a gap
        mirrorMock.orderLegacyIdsPresent.mockResolvedValue(new Set(['700']));
        prismaMock.paymentException.findMany.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
            isEnrollmentLookup(where) ? [{ programId: 7, personId: 3 }] : [],
        );
        const r = await runMatchAudit();
        expect(r.enrollments[0].bucket).toBe('ORDER_MATCHED');
    });
});
