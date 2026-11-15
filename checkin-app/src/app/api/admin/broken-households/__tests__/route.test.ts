/**
 * @jest-environment node
 */
/**
 * GET /api/admin/broken-households selects only the household and member columns
 * the Broken Households tab shows: no address, intake note or membership row.
 */
import { getServerSession } from 'next-auth/next';
import prisma from '@/lib/prisma';
import { GET } from '../route';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: { household: { findMany: jest.fn() } },
}));

const findMany = prisma.household.findMany as jest.Mock;

beforeEach(() => {
    jest.clearAllMocks();
    (getServerSession as jest.Mock).mockResolvedValue({ user: { id: 1, isBoardMember: true } });
    findMany.mockResolvedValue([
        { id: 7, name: '', householdMembers: [{ id: 3, name: 'Kid', dateOfBirth: new Date('2015-01-01T00:00:00Z') }] },
    ]);
});

it('selects only the household id, name and member columns', async () => {
    expect((await GET(new Request('http://localhost/api/admin/broken-households'))).status).toBe(200);

    const args = findMany.mock.calls[0][0];
    expect(args).not.toHaveProperty('include');
    expect(Object.keys(args.select).sort()).toEqual(['householdMembers', 'id', 'name']);
    expect(args.select.householdMembers.select).toEqual({ id: true, name: true, dateOfBirth: true });
});

it('ships each household as id, name and members', async () => {
    const body = await (await GET(new Request('http://localhost/api/admin/broken-households'))).json();

    expect(body.households).toEqual([
        { id: 7, name: 'Household #7', members: [{ id: 3, name: 'Kid', dateOfBirth: '2015-01-01T00:00:00.000Z' }] },
    ]);
});
