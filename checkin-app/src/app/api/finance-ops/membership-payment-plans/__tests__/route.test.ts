/**
 * @jest-environment node
 */
/**
 * GET /api/finance-ops/membership-payment-plans through the real handler():
 * finance holds everyones:pii on this route, so the query selects only the
 * columns the queue shows.
 */
import type { NextRequest } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { GET } from '../route';

jest.mock('@/lib/finance/financeViewLog', () => ({
    ...jest.requireActual('@/lib/finance/financeViewLog'),
    recordFinanceViewCall: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));

const prismaMock = {
    orgMembershipProcess: { findMany: jest.fn() },
    boardSettings: { findUnique: jest.fn() },
};
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        orgMembershipProcess: { findMany: (...a: unknown[]) => prismaMock.orgMembershipProcess.findMany(...a) },
        boardSettings: { findUnique: (...a: unknown[]) => prismaMock.boardSettings.findUnique(...a) },
    },
}));

const mockSession = jest.mocked(getServerSession);

const req = () => new Request('http://localhost/api/finance-ops/membership-payment-plans') as unknown as NextRequest;

beforeEach(() => {
    jest.clearAllMocks();
    mockSession.mockResolvedValue({ user: { id: 5, isFinance: true, isBoardMember: false } });
    prismaMock.boardSettings.findUnique.mockResolvedValue({ orgMembershipYearBoundary: new Date(Date.UTC(2000, 8, 1)) });
    prismaMock.orgMembershipProcess.findMany.mockResolvedValue([
        {
            id: 7, stageEnteredAt: new Date('2026-10-01T00:00:00Z'), scholarshipRequestKind: null, paymentPlanYear: 2027,
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
    expect(Object.keys(select).sort()).toEqual(['id', 'orgMembership', 'paymentPlanYear', 'scholarshipRequestKind', 'stageEnteredAt']);
    expect(Object.keys(select.orgMembership.select).sort()).toEqual(['household', 'id', 'isVolunteerFamily']);
    expect(Object.keys(select.orgMembership.select.household.select).sort()).toEqual(['householdMembers', 'id', 'name']);
});

it('ships only the year cutoff from BoardSettings', async () => {
    const body = await (await GET(req())).json();

    expect(prismaMock.boardSettings.findUnique.mock.calls[0][0].select).toEqual({ orgMembershipYearBoundary: true });
    expect(body.BoardSettings).toEqual({ orgMembershipYearBoundary: '2000-09-01T00:00:00.000Z' });
});

it('ships finance the household-lead contact', async () => {
    const body = await (await GET(req())).json();

    expect(body.OrgMembershipProcess[0].orgMembership.household.householdMembers[0].email).toBe('lead@example.com');
});

it('ships the year each request is for; one with no stored year gets the live year', async () => {
    jest.useFakeTimers({ now: new Date('2027-07-15T00:00:00Z'), doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate', 'setTimeout'] });
    const stored = await (await GET(req())).json();
    expect(stored.OrgMembershipProcess[0].paymentPlanYear).toBe(2027);

    prismaMock.orgMembershipProcess.findMany.mockResolvedValueOnce([
        { id: 8, stageEnteredAt: new Date('2026-10-01T00:00:00Z'), scholarshipRequestKind: null, paymentPlanYear: null, orgMembership: null },
    ]);
    const fallback = await (await GET(req())).json();
    expect(fallback.OrgMembershipProcess[0].paymentPlanYear).toBe(2027);
    jest.useRealTimers();
});
