/**
 * @jest-environment node
 */
/**
 * GET /api/people/search?filter=adults backs the Program Leader pickers: each person
 * carries the reason the server's leader check would refuse them, from the same helper.
 */
import { getServerSession } from 'next-auth/next';
import { GET } from '../route';
import { leaderIneligibilities } from '@/lib/programs/leaderEligibility';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));
jest.mock('@/lib/programs/leaderEligibility', () => ({ leaderIneligibilities: jest.fn() }));

const findManyMock = jest.fn();
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        person: { findMany: (...args: unknown[]) => findManyMock(...args) },
        boardSettings: { findUnique: jest.fn().mockResolvedValue({ orgMembershipYearBoundary: new Date('2020-09-01') }) },
    },
}));

const checked = new Date('2099-06-01');
const person = (id: number, status: string) => ({
    id, name: `P${id}`, nickname: null, email: `p${id}@example.com`, phone: null, dateOfBirth: null, isDeclaredAdult: true,
    lastBackgroundCheck: checked, roles: [], household: { id, name: 'H', householdMembers: [], orgMembership: { status } },
});

const get = async (query: string) => (await (await GET(new Request(`http://localhost/api/people/search?${query}`))).json()).people;

beforeEach(() => {
    jest.clearAllMocks();
    findManyMock.mockResolvedValue([person(1, 'ACTIVE'), person(2, 'REVOKED')]);
    (leaderIneligibilities as jest.Mock).mockResolvedValue(new Map([[1, null], [2, 'Program Leader must be in an active Treehouse Membership']]));
    (getServerSession as jest.Mock).mockResolvedValue({ user: { id: 9, isBoardMember: true } });
});

describe('GET /api/people/search — leader picker', () => {
    it('marks each adult with the shared helper’s reason', async () => {
        const people = await get('q=p&filter=adults');
        expect(leaderIneligibilities).toHaveBeenCalledWith(expect.anything(), [
            { id: 1, isMember: true, lastBackgroundCheck: checked },
            { id: 2, isMember: false, lastBackgroundCheck: checked },
        ], expect.any(Number));
        expect(people.map((p: { leaderIneligibility: string | null }) => p.leaderIneligibility)).toEqual([null, expect.stringMatching(/active Treehouse Membership/)]);
    });

    it("judges a program's picker for that program's membership year", async () => {
        await get('q=p&filter=adults&year=2031');
        expect(leaderIneligibilities).toHaveBeenCalledWith(expect.anything(), expect.anything(), 2031);
    });

    it('leaves the plain directory search unmarked', async () => {
        const people = await get('q=p');
        expect(leaderIneligibilities).not.toHaveBeenCalled();
        expect(people[0]).not.toHaveProperty('leaderIneligibility');
    });

    it('never gives Operations a reason, which would reveal check standing', async () => {
        (getServerSession as jest.Mock).mockResolvedValue({ user: { id: 9, isOperations: true } });
        const people = await get('q=p&filter=adults');
        expect(leaderIneligibilities).not.toHaveBeenCalled();
        expect(people[0]).not.toHaveProperty('leaderIneligibility');
    });
});
