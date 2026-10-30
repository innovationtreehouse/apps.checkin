/**
 * @jest-environment node
 */
/**
 * GET /api/finance-ops/payment-plans through the real handler(): finance holds
 * everyones:pii on this route, so the query selects only the columns the queue
 * shows. A household's intake note and a person's date of birth or allergies are
 * never read.
 */
import type { NextRequest } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { GET } from '../route';

jest.mock('@/lib/finance/financeViewLog', () => ({ recordFinanceView: jest.fn().mockResolvedValue(undefined) }));
jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));

const prismaMock = {
    programParticipant: { findMany: jest.fn() },
    boardSettings: { findUnique: jest.fn() },
};
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        programParticipant: { findMany: (...a: unknown[]) => prismaMock.programParticipant.findMany(...a) },
        boardSettings: { findUnique: (...a: unknown[]) => prismaMock.boardSettings.findUnique(...a) },
    },
}));

const mockSession = jest.mocked(getServerSession);

const req = () => new Request('http://localhost/api/finance-ops/payment-plans') as unknown as NextRequest;

beforeEach(() => {
    jest.clearAllMocks();
    mockSession.mockResolvedValue({ user: { id: 5, isFinance: true, isBoardMember: false } });
    prismaMock.programParticipant.findMany.mockResolvedValue([
        {
            programId: 1, personId: 2, status: 'PENDING', isPaymentPlanRequested: true, pendingSince: new Date('2026-10-01T00:00:00Z'),
            person: {
                id: 2, name: 'Kid', email: 'kid@example.com', householdId: 9,
                household: {
                    id: 9,
                    orgMembership: { status: 'ACTIVE' },
                    householdMembers: [{ id: 3, name: 'Lead', email: 'lead@example.com' }],
                },
            },
            program: { id: 1, name: 'Woodshop', startAt: new Date('2026-11-01T00:00:00Z'), orgMemberPriceCents: 100, nonOrgMemberPriceCents: 200 },
        },
    ]);
    prismaMock.boardSettings.findUnique.mockResolvedValue({ id: 1, orgMembershipYearBoundary: null });
});

it('selects only the person, household and program columns the queue shows', async () => {
    expect((await GET(req())).status).toBe(200);

    const { include } = prismaMock.programParticipant.findMany.mock.calls[0][0];
    expect(Object.keys(include.person.select).sort()).toEqual(['email', 'household', 'householdId', 'id', 'name']);
    expect(Object.keys(include.person.select.household.select).sort()).toEqual(['householdMembers', 'id', 'orgMembership']);
    expect(include.person.select.household.select.orgMembership).toEqual({ select: { status: true } });
    expect(Object.keys(include.program.select).sort()).toEqual(['id', 'name', 'nonOrgMemberPriceCents', 'orgMemberPriceCents', 'startAt']);
});

it('ships finance the participant and household-lead contact', async () => {
    const body = await (await GET(req())).json();

    expect(body.ProgramParticipant[0].person.email).toBe('kid@example.com');
    expect(body.ProgramParticipant[0].person.household.householdMembers[0].email).toBe('lead@example.com');
});
