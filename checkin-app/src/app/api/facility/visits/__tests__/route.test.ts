/**
 * @jest-environment node
 */
/**
 * GET /api/facility/visits through the real handler(): the query selects only
 * the visit columns and person fields the visit log shows, plus the closer's
 * name on the closed-out list.
 */
import type { NextRequest } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { GET } from '../route';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));

const findMany = jest.fn();
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: { visit: { findMany: (...a: unknown[]) => findMany(...a) } },
}));

const req = (query = '') => new Request(`http://localhost/api/facility/visits${query}`) as unknown as NextRequest;

const VISIT_COLUMNS = ['arrivedAt', 'arrivedVia', 'departedAt', 'departedVia', 'facilityCloseId', 'id', 'person', 'personId'];

beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(getServerSession).mockResolvedValue({ user: { id: 5, isSysadmin: true } });
    findMany.mockResolvedValue([]);
});

it('selects only the columns the visit log shows', async () => {
    expect((await GET(req())).status).toBe(200);

    const args = findMany.mock.calls[0][0];
    expect(args).not.toHaveProperty('include');
    expect(Object.keys(args.select).sort()).toEqual(VISIT_COLUMNS);
    expect(args.select.person).toEqual({ select: { email: true, name: true } });
});

it('adds the closer name on the closed-out list', async () => {
    expect((await GET(req('?closedOut=true'))).status).toBe(200);

    const { select } = findMany.mock.calls[0][0];
    expect(Object.keys(select).sort()).toEqual([...VISIT_COLUMNS, 'facilityClose'].sort());
    expect(select.facilityClose).toEqual({ select: { closedBy: { select: { name: true } } } });
});
