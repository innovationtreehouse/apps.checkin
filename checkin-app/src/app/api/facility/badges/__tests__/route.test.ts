/**
 * @jest-environment node
 */
/**
 * GET /api/facility/badges through the real handler(): the query selects only
 * the badge columns and person fields the badge log shows.
 */
import type { NextRequest } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { GET } from '../route';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));

const findMany = jest.fn();
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: { rawBadgeLog: { findMany: (...a: unknown[]) => findMany(...a) } },
}));

const req = () => new Request('http://localhost/api/facility/badges') as unknown as NextRequest;

beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(getServerSession).mockResolvedValue({ user: { id: 5, isSysadmin: true } });
    findMany.mockResolvedValue([
        { id: 1, timestamp: new Date('2026-10-01T00:00:00Z'), location: 'Front Door', person: { name: 'Kid', email: 'kid@example.com' } },
    ]);
});

it('selects only the columns the badge log shows', async () => {
    expect((await GET(req())).status).toBe(200);

    const args = findMany.mock.calls[0][0];
    expect(args).not.toHaveProperty('include');
    expect(Object.keys(args.select).sort()).toEqual(['id', 'location', 'person', 'timestamp']);
    expect(args.select.person).toEqual({ select: { name: true, email: true } });
});

it('ships each badge event with exactly those columns', async () => {
    const body = await (await GET(req())).json();

    expect(Object.keys(body.badges[0]).sort()).toEqual(['id', 'location', 'person', 'timestamp']);
    expect(body.badges[0].person).toEqual({ name: 'Kid', email: 'kid@example.com' });
});
