/**
 * @jest-environment node
 */
/**
 * GET /api/finance-ops/membership-payment-plans through the real handler():
 * finance holds everyones:pii on this route, so the query selects only the
 * columns the queue shows. The household's intake note and the process's
 * snapshot of it are never read.
 */
import type { NextRequest } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { GET } from '../route';

jest.mock('@/lib/finance/financeViewLog', () => ({ recordFinanceView: jest.fn().mockResolvedValue(undefined) }));
jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));

const prismaMock = {
    orgMembershipProcess: { findMany: jest.fn() },
};
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        orgMembershipProcess: { findMany: (...a: unknown[]) => prismaMock.orgMembershipProcess.findMany(...a) },
    },
}));

const mockSession = jest.mocked(getServerSession);

const req = () => new Request('http://localhost/api/finance-ops/membership-payment-plans') as unknown as NextRequest;

beforeEach(() => {
    jest.clearAllMocks();
    mockSession.mockResolvedValue({ user: { id: 5, isFinance: true, isBoardMember: false } });
    prismaMock.orgMembershipProcess.findMany.mockResolvedValue([
        {
            id: 7, stageEnteredAt: new Date('2026-10-01T00:00:00Z'), scholarshipRequestKind: null,
            orgMembership: {
                id: 4, isVolunteerFamily: false,
                household: { id: 9, name: 'The Family', householdMembers: [{ id: 3, name: 'Lead', email: 'lead@example.com' }] },
            },
        },
    ]);
});

it('selects only the process, membership and household columns the queue shows', async () => {
    expect((await GET(req())).status).toBe(200);

    const { select } = prismaMock.orgMembershipProcess.findMany.mock.calls[0][0];
    expect(Object.keys(select).sort()).toEqual(['id', 'orgMembership', 'scholarshipRequestKind', 'stageEnteredAt']);
    expect(Object.keys(select.orgMembership.select).sort()).toEqual(['household', 'id', 'isVolunteerFamily']);
    expect(Object.keys(select.orgMembership.select.household.select).sort()).toEqual(['householdMembers', 'id', 'name']);
});

it('ships finance the household-lead contact', async () => {
    const body = await (await GET(req())).json();

    expect(body[0].orgMembership.household.householdMembers[0].email).toBe('lead@example.com');
});
