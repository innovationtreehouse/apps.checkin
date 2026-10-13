/**
 * @jest-environment node
 */
/**
 * Unit tests for POST /api/finance-ops/s-read/match-audit/track — the deny paths
 * (401 anon / 403 non-board through the REAL withAuth, asserting no exception is
 * ever raised) and the per-kind re-validation: each kind re-derives its gap
 * condition from raw Prisma columns / mirror presence, so a stale panel (a row
 * already resolved since the audit ran) is rejected with 409, not tracked. The
 * dedup behavior of raisePaymentException itself is reconcile.ts's tested
 * concern — here we only assert the route forwards to it (or doesn't).
 */
import { POST } from '../route';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));

const prismaMock = {
    orgMembershipProcess: { findFirst: jest.fn(), findUnique: jest.fn() },
    programParticipant: { findFirst: jest.fn(), findUnique: jest.fn() },
};
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        orgMembershipProcess: {
            findFirst: (...a: unknown[]) => prismaMock.orgMembershipProcess.findFirst(...a),
            findUnique: (...a: unknown[]) => prismaMock.orgMembershipProcess.findUnique(...a),
        },
        programParticipant: {
            findFirst: (...a: unknown[]) => prismaMock.programParticipant.findFirst(...a),
            findUnique: (...a: unknown[]) => prismaMock.programParticipant.findUnique(...a),
        },
    },
}));

const mirrorMock = {
    isConfigured: jest.fn(),
    ordersByLegacyIds: jest.fn(),
    orderLegacyIdsPresent: jest.fn(),
};
jest.mock('@/lib/shopifyRead/client', () => ({
    isConfigured: () => mirrorMock.isConfigured(),
    ordersByLegacyIds: (...a: unknown[]) => mirrorMock.ordersByLegacyIds(...a),
    orderLegacyIdsPresent: (...a: unknown[]) => mirrorMock.orderLegacyIdsPresent(...a),
}));

// Keep the real isPaid (a pure predicate the tests need correct), spy only on
// raisePaymentException — the write path this route must never hit on a deny
// or stale-row rejection.
const raisePaymentExceptionMock = jest.fn();
jest.mock('@/lib/finance/reconcile', () => ({
    ...jest.requireActual('@/lib/finance/reconcile'),
    raisePaymentException: (...a: unknown[]) => raisePaymentExceptionMock(...a),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const mockSession = require('next-auth/next').getServerSession;

const req = (body: unknown) =>
    new Request('http://localhost/api/finance-ops/s-read/match-audit/track', {
        method: 'POST',
        body: JSON.stringify(body),
    });

const asBoard = () => mockSession.mockResolvedValue({ user: { id: 5, isBoardMember: true } });

const paidOrder = (legacyId: string, over: Partial<Record<string, unknown>> = {}) => ({
    legacyId,
    financialStatus: 'PAID',
    cancelledAt: null,
    totalRefundedCents: 0,
    ...over,
});

beforeEach(() => {
    jest.clearAllMocks();
    mirrorMock.isConfigured.mockReturnValue(true);
    mirrorMock.ordersByLegacyIds.mockResolvedValue([]);
    mirrorMock.orderLegacyIdsPresent.mockResolvedValue(new Set());
    prismaMock.orgMembershipProcess.findFirst.mockResolvedValue(null);
    prismaMock.orgMembershipProcess.findUnique.mockResolvedValue(null);
    prismaMock.programParticipant.findFirst.mockResolvedValue(null);
    prismaMock.programParticipant.findUnique.mockResolvedValue(null);
});

it('401 when unauthenticated, without raising anything', async () => {
    mockSession.mockResolvedValue(null);
    const res = await POST(req({ kind: 'order', shopifyOrderId: '900' }));
    expect(res.status).toBe(401);
    expect(raisePaymentExceptionMock).not.toHaveBeenCalled();
    expect(prismaMock.orgMembershipProcess.findFirst).not.toHaveBeenCalled();
});

it('403 for a signed-in member without the board role, without raising anything', async () => {
    mockSession.mockResolvedValue({ user: { id: 5, isSysadmin: false, isBoardMember: false } });
    const res = await POST(req({ kind: 'order', shopifyOrderId: '900' }));
    expect(res.status).toBe(403);
    expect(raisePaymentExceptionMock).not.toHaveBeenCalled();
});

it('403 for a sysadmin who is not on the board, without raising anything', async () => {
    mockSession.mockResolvedValue({ user: { id: 5, isSysadmin: true, isBoardMember: false } });
    const res = await POST(req({ kind: 'order', shopifyOrderId: '900' }));
    expect(res.status).toBe(403);
    expect(raisePaymentExceptionMock).not.toHaveBeenCalled();
});

it('503 when the mirror is unwired', async () => {
    asBoard();
    mirrorMock.isConfigured.mockReturnValue(false);
    const res = await POST(req({ kind: 'order', shopifyOrderId: '900' }));
    expect(res.status).toBe(503);
    expect(raisePaymentExceptionMock).not.toHaveBeenCalled();
});

describe('bad body', () => {
    beforeEach(asBoard);

    it('400 when kind is missing or unrecognised', async () => {
        expect((await POST(req({}))).status).toBe(400);
        expect((await POST(req({ kind: 'bogus' }))).status).toBe(400);
        expect(raisePaymentExceptionMock).not.toHaveBeenCalled();
    });

    it('400 when a membership processId is not numeric', async () => {
        const res = await POST(req({ kind: 'membership', processId: 'abc' }));
        expect(res.status).toBe(400);
        expect(raisePaymentExceptionMock).not.toHaveBeenCalled();
    });
});

describe('kind: order', () => {
    beforeEach(asBoard);

    it('paid, unclaimed → 200 tracked, raises UNMATCHED_ORDER keyed by shopifyOrderId', async () => {
        mirrorMock.ordersByLegacyIds.mockResolvedValue([paidOrder('900')]);
        const res = await POST(req({ kind: 'order', shopifyOrderId: '900' }));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ tracked: true });
        expect(raisePaymentExceptionMock).toHaveBeenCalledWith('UNMATCHED_ORDER', { shopifyOrderId: '900' });
    });

    it('409 when the order is no longer paid (refunded since the audit) — not raised', async () => {
        mirrorMock.ordersByLegacyIds.mockResolvedValue([paidOrder('901', { financialStatus: 'REFUNDED', totalRefundedCents: 5000 })]);
        const res = await POST(req({ kind: 'order', shopifyOrderId: '901' }));
        expect(res.status).toBe(409);
        expect(raisePaymentExceptionMock).not.toHaveBeenCalled();
    });

    it('409 when a membership process has since claimed the order — not raised', async () => {
        mirrorMock.ordersByLegacyIds.mockResolvedValue([paidOrder('902')]);
        prismaMock.orgMembershipProcess.findFirst.mockResolvedValue({ id: 1 });
        const res = await POST(req({ kind: 'order', shopifyOrderId: '902' }));
        expect(res.status).toBe(409);
        expect(raisePaymentExceptionMock).not.toHaveBeenCalled();
    });

    it('409 when a program enrollment has since claimed the order — not raised', async () => {
        mirrorMock.ordersByLegacyIds.mockResolvedValue([paidOrder('903')]);
        prismaMock.programParticipant.findFirst.mockResolvedValue({ programId: 7 });
        const res = await POST(req({ kind: 'order', shopifyOrderId: '903' }));
        expect(res.status).toBe(409);
        expect(raisePaymentExceptionMock).not.toHaveBeenCalled();
    });

    it('409 when the order is not found in the mirror at all', async () => {
        mirrorMock.ordersByLegacyIds.mockResolvedValue([]);
        const res = await POST(req({ kind: 'order', shopifyOrderId: '904' }));
        expect(res.status).toBe(409);
        expect(raisePaymentExceptionMock).not.toHaveBeenCalled();
    });

    it('idempotent repeat click: 200 both times, simply forwards to raisePaymentException each time', async () => {
        mirrorMock.ordersByLegacyIds.mockResolvedValue([paidOrder('905')]);
        const first = await POST(req({ kind: 'order', shopifyOrderId: '905' }));
        const second = await POST(req({ kind: 'order', shopifyOrderId: '905' }));
        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
        expect(raisePaymentExceptionMock).toHaveBeenCalledTimes(2);
    });
});

describe('kind: membership', () => {
    beforeEach(asBoard);

    it('active, no order, no manual payment → 200 tracked, raises ACTIVE_WITHOUT_PAYMENT keyed by processId', async () => {
        prismaMock.orgMembershipProcess.findUnique.mockResolvedValue({
            status: 'ACTIVE', kind: 'INITIAL', shopifyOrderId: null, manualPaymentById: null,
        });
        const res = await POST(req({ kind: 'membership', processId: 42 }));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ tracked: true });
        expect(raisePaymentExceptionMock).toHaveBeenCalledWith('ACTIVE_WITHOUT_PAYMENT', { processId: 42 });
    });

    it('409 when the payment has since been recorded manually', async () => {
        prismaMock.orgMembershipProcess.findUnique.mockResolvedValue({
            status: 'ACTIVE', kind: 'INITIAL', shopifyOrderId: null, manualPaymentById: 7,
        });
        const res = await POST(req({ kind: 'membership', processId: 42 }));
        expect(res.status).toBe(409);
        expect(raisePaymentExceptionMock).not.toHaveBeenCalled();
    });

    it('409 when the order is now present in the mirror', async () => {
        prismaMock.orgMembershipProcess.findUnique.mockResolvedValue({
            status: 'ACTIVE', kind: 'INITIAL', shopifyOrderId: '800', manualPaymentById: null,
        });
        mirrorMock.orderLegacyIdsPresent.mockResolvedValue(new Set(['800']));
        const res = await POST(req({ kind: 'membership', processId: 42 }));
        expect(res.status).toBe(409);
        expect(raisePaymentExceptionMock).not.toHaveBeenCalled();
    });

    it('recorded order absent from the mirror → PAYMENT_UNVERIFIABLE, not ACTIVE_WITHOUT_PAYMENT', async () => {
        prismaMock.orgMembershipProcess.findUnique.mockResolvedValue({
            status: 'ACTIVE', kind: 'RENEWAL', shopifyOrderId: '801', manualPaymentById: null,
        });
        mirrorMock.orderLegacyIdsPresent.mockResolvedValue(new Set()); // 801 not present
        const res = await POST(req({ kind: 'membership', processId: 42 }));
        expect(res.status).toBe(200);
        // A payment IS on record (order 801) — it just can't be verified.
        expect(raisePaymentExceptionMock).toHaveBeenCalledWith('PAYMENT_UNVERIFIABLE', { processId: 42 });
    });

    it('409 for a process outside the audit-swept status/kind population', async () => {
        prismaMock.orgMembershipProcess.findUnique.mockResolvedValue({
            status: 'PENDING_PAYMENT', kind: 'INITIAL', shopifyOrderId: null, manualPaymentById: null,
        });
        const res = await POST(req({ kind: 'membership', processId: 42 }));
        expect(res.status).toBe(409);
        expect(raisePaymentExceptionMock).not.toHaveBeenCalled();
    });

    it('404 when the process no longer exists', async () => {
        const res = await POST(req({ kind: 'membership', processId: 42 }));
        expect(res.status).toBe(404);
        expect(raisePaymentExceptionMock).not.toHaveBeenCalled();
    });
});

describe('kind: enrollment', () => {
    beforeEach(asBoard);

    it('active, no order, no scholarship stamp → 200 tracked, raises ACTIVE_WITHOUT_PAYMENT keyed by (programId, personId)', async () => {
        prismaMock.programParticipant.findUnique.mockResolvedValue({
            status: 'ACTIVE', shopifyOrderId: null, wasOrgMemberAtApproval: null,
        });
        const res = await POST(req({ kind: 'enrollment', programId: 7, personId: 9 }));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ tracked: true });
        expect(raisePaymentExceptionMock).toHaveBeenCalledWith('ACTIVE_WITHOUT_PAYMENT', { programId: 7, personId: 9 });
    });

    it('409 when since scholarship-approved', async () => {
        prismaMock.programParticipant.findUnique.mockResolvedValue({
            status: 'ACTIVE', shopifyOrderId: null, wasOrgMemberAtApproval: true,
        });
        const res = await POST(req({ kind: 'enrollment', programId: 7, personId: 9 }));
        expect(res.status).toBe(409);
        expect(raisePaymentExceptionMock).not.toHaveBeenCalled();
    });

    it('recorded order absent from the mirror → PAYMENT_UNVERIFIABLE, not ACTIVE_WITHOUT_PAYMENT', async () => {
        prismaMock.programParticipant.findUnique.mockResolvedValue({
            status: 'ACTIVE', shopifyOrderId: '802', wasOrgMemberAtApproval: null,
        });
        mirrorMock.orderLegacyIdsPresent.mockResolvedValue(new Set()); // 802 not present
        const res = await POST(req({ kind: 'enrollment', programId: 7, personId: 9 }));
        expect(res.status).toBe(200);
        expect(raisePaymentExceptionMock).toHaveBeenCalledWith('PAYMENT_UNVERIFIABLE', { programId: 7, personId: 9 });
    });

    it('409 when the recorded order is now present in the mirror', async () => {
        prismaMock.programParticipant.findUnique.mockResolvedValue({
            status: 'ACTIVE', shopifyOrderId: '803', wasOrgMemberAtApproval: null,
        });
        mirrorMock.orderLegacyIdsPresent.mockResolvedValue(new Set(['803']));
        const res = await POST(req({ kind: 'enrollment', programId: 7, personId: 9 }));
        expect(res.status).toBe(409);
        expect(raisePaymentExceptionMock).not.toHaveBeenCalled();
    });

    it('409 when no longer ACTIVE', async () => {
        prismaMock.programParticipant.findUnique.mockResolvedValue({
            status: 'PENDING', shopifyOrderId: null, wasOrgMemberAtApproval: null,
        });
        const res = await POST(req({ kind: 'enrollment', programId: 7, personId: 9 }));
        expect(res.status).toBe(409);
        expect(raisePaymentExceptionMock).not.toHaveBeenCalled();
    });

    it('404 when the enrollment no longer exists', async () => {
        const res = await POST(req({ kind: 'enrollment', programId: 7, personId: 9 }));
        expect(res.status).toBe(404);
        expect(raisePaymentExceptionMock).not.toHaveBeenCalled();
    });
});
