/**
 * @jest-environment node
 */
/**
 * GET /api/people/search — the id leg of `q`. The Participants directory prints the
 * id column, so a bare number has to find that person; it must stay OR'd with the
 * text match (a number can also live inside a name or email) and must never reach
 * Prisma as an out-of-int4 literal.
 */
import { getServerSession } from 'next-auth/next';
import type { Prisma } from '@/generated/prisma/client';
import { GET } from '../route';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));

const findManyMock = jest.fn();
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: { person: { findMany: (...args: unknown[]) => findManyMock(...args) } },
}));

const mockSession = getServerSession as jest.Mock;

function req(query: string) {
    return new Request(`http://localhost/api/people/search?${query}`);
}

// The `q` clause is the first entry of the where AND array (see route).
function textOrLegs(): Prisma.PersonWhereInput[] {
    const where = findManyMock.mock.calls[0][0].where as Prisma.PersonWhereInput;
    const and = where.AND as Prisma.PersonWhereInput[];
    return (and[0].OR ?? []) as Prisma.PersonWhereInput[];
}

beforeEach(() => {
    jest.clearAllMocks();
    findManyMock.mockResolvedValue([]);
    mockSession.mockResolvedValue({ user: { id: 1, isSysadmin: true, isBoardMember: false } });
});

describe('GET /api/people/search — search by id', () => {
    it('matches the id alongside name and email for a numeric query', async () => {
        const res = await GET(req('q=42'));
        expect(res.status).toBe(200);
        expect(textOrLegs()).toEqual([
            { name: { contains: '42', mode: 'insensitive' } },
            { email: { contains: '42', mode: 'insensitive' } },
            { id: 42 },
        ]);
    });

    it('adds no id leg for a non-numeric query', async () => {
        await GET(req('q=ali'));
        expect(textOrLegs()).toEqual([
            { name: { contains: 'ali', mode: 'insensitive' } },
            { email: { contains: 'ali', mode: 'insensitive' } },
        ]);
    });

    it('adds no id leg for a number past the int4 ceiling', async () => {
        await GET(req('q=99999999999'));
        expect(textOrLegs()).toHaveLength(2);
    });

    it('still applies the adults filter alongside an id query', async () => {
        await GET(req('q=42&filter=adults'));
        const where = findManyMock.mock.calls[0][0].where as Prisma.PersonWhereInput;
        expect((where.AND as Prisma.PersonWhereInput[])).toHaveLength(2);
        expect(textOrLegs()).toContainEqual({ id: 42 });
    });
});
