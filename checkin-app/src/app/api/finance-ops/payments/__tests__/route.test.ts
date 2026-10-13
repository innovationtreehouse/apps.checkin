/**
 * @jest-environment node
 */
/**
 * Unit tests for GET /api/finance-ops/payments through the REAL handler(): the
 * board-only gate, the response shape (one row per open exception, with the live
 * mirror amounts), and that the mirror's buyer columns never reach the wire even
 * when a mirror row carries them.
 */
import type { NextRequest } from 'next/server';
import { GET } from '../route';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));

const prismaMock = {
    paymentException: { findMany: jest.fn() },
    orgMembershipProcess: { findMany: jest.fn() },
    person: { findMany: jest.fn() },
    program: { findMany: jest.fn() },
};
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        paymentException: { findMany: (...a: unknown[]) => prismaMock.paymentException.findMany(...a) },
        orgMembershipProcess: { findMany: (...a: unknown[]) => prismaMock.orgMembershipProcess.findMany(...a) },
        person: { findMany: (...a: unknown[]) => prismaMock.person.findMany(...a) },
        program: { findMany: (...a: unknown[]) => prismaMock.program.findMany(...a) },
    },
}));

const ordersByLegacyIdsMock = jest.fn();
jest.mock('@/lib/shopifyRead/client', () => ({
    ordersByLegacyIds: (...a: unknown[]) => ordersByLegacyIdsMock(...a),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const mockSession = require('next-auth/next').getServerSession;

const req = () => new Request('http://localhost/api/finance-ops/payments') as unknown as NextRequest;

const detectedAt = new Date('2026-10-01T12:00:00Z');

beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.paymentException.findMany.mockResolvedValue([
        { id: 1, kind: 'ORDER_REFUNDED', severity: 'WARN', status: 'OPEN', shopifyOrderId: '900', processId: null, programId: 3, personId: 4, detectedAt, resolutionNote: 'internal note' },
    ]);
    prismaMock.orgMembershipProcess.findMany.mockResolvedValue([]);
    prismaMock.person.findMany.mockResolvedValue([{ id: 4, name: 'Pat', email: 'pat@example.com' }]);
    prismaMock.program.findMany.mockResolvedValue([{ id: 3, name: 'Robotics' }]);
    ordersByLegacyIdsMock.mockResolvedValue([
        {
            orderGid: 'gid://shopify/Order/900', legacyId: '900', customerEmail: 'buyer@example.com',
            financialStatus: 'REFUNDED', totalCents: 5000, subtotalCents: 5000, totalRefundedCents: 5000,
            discountCents: 0, discountCodes: [], cancelledAt: null, updatedAt: detectedAt, noteAttributes: null,
        },
    ]);
});

it('401 when unauthenticated, without reading anything', async () => {
    mockSession.mockResolvedValue(null);
    expect((await GET(req())).status).toBe(401);
    expect(prismaMock.paymentException.findMany).not.toHaveBeenCalled();
});

it.each([
    ['a plain member', { isSysadmin: false, isBoardMember: false }],
    ['a sysadmin', { isSysadmin: true, isBoardMember: false }],
    ['finance', { isFinance: true, isBoardMember: false }],
])('403 for %s, without reading anything', async (_who, flags) => {
    mockSession.mockResolvedValue({ user: { id: 5, ...flags } });
    expect((await GET(req())).status).toBe(403);
    expect(prismaMock.paymentException.findMany).not.toHaveBeenCalled();
});

it('returns the queue with live mirror amounts for a board member, and no buyer columns', async () => {
    mockSession.mockResolvedValue({ user: { id: 5, isBoardMember: true } });
    const res = await GET(req());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
        {
            id: 1,
            kind: 'ORDER_REFUNDED',
            severity: 'WARN',
            status: 'OPEN',
            shopifyOrderId: '900',
            processId: null,
            programId: 3,
            personId: 4,
            detectedAt: detectedAt.toISOString(),
            familyName: 'Pat',
            familyEmail: 'pat@example.com',
            programName: 'Robotics',
            live: { financialStatus: 'REFUNDED', totalCents: 5000, totalRefundedCents: 5000, cancelledAt: null },
        },
    ]);
});

it('lists the row without a live block when the mirror read fails', async () => {
    mockSession.mockResolvedValue({ user: { id: 5, isBoardMember: true } });
    ordersByLegacyIdsMock.mockRejectedValue(new Error('mirror down'));
    const [row] = await (await GET(req())).json();
    expect(row.live).toBeNull();
});
