/**
 * @jest-environment node
 */
/**
 * GET /api/facility/visits through the real handler(): the query selects only
 * the visit columns, person fields and event name the visit log shows, plus the closer's
 * name on the closed-out list, and the remover on the removed list.
 */
import type { NextRequest } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { GET } from '../route';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));

const findMany = jest.fn();
const findPeople = jest.fn();
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        visit: { findMany: (...a: unknown[]) => findMany(...a) },
        person: { findMany: (...a: unknown[]) => findPeople(...a) },
    },
}));

const req = (query = '') => new Request(`http://localhost/api/facility/visits${query}`) as unknown as NextRequest;

const VISIT_COLUMNS = ['arrivedAt', 'arrivedVia', 'departedAt', 'departedVia', 'event', 'facilityCloseId', 'id', 'person', 'personId'];

beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(getServerSession).mockResolvedValue({ user: { id: 5, isSysadmin: true } });
    findMany.mockResolvedValue([]);
    findPeople.mockResolvedValue([]);
});

it('selects only the columns the visit log shows', async () => {
    expect((await GET(req())).status).toBe(200);

    const args = findMany.mock.calls[0][0];
    expect(args).not.toHaveProperty('include');
    expect(Object.keys(args.select).sort()).toEqual(VISIT_COLUMNS);
    expect(args.select.person).toEqual({ select: { email: true, name: true } });
    expect(args.select.event).toEqual({ select: { name: true } });
});

it('adds the closer name on the closed-out list', async () => {
    expect((await GET(req('?closedOut=true'))).status).toBe(200);

    const { select } = findMany.mock.calls[0][0];
    expect(Object.keys(select).sort()).toEqual([...VISIT_COLUMNS, 'facilityClose'].sort());
    expect(select.facilityClose).toEqual({ select: { closedBy: { select: { name: true } } } });
});

it('lists removed visits with when and by whom, and names each remover once', async () => {
    const deletedAt = new Date('2026-11-01T12:00:00Z');
    findMany.mockResolvedValue([
        { id: 1, personId: 2, deletedAt, deletedById: 9 },
        { id: 3, personId: 4, deletedAt, deletedById: 9 },
        { id: 5, personId: 4, deletedAt, deletedById: null },
    ]);
    findPeople.mockResolvedValue([{ id: 9, name: 'Bo Board' }]);

    const res = await GET(req('?removed=true'));

    expect(res.status).toBe(200);
    const args = findMany.mock.calls[0][0];
    expect(args.where).toEqual({ deletedAt: { not: null } });
    expect(Object.keys(args.select).sort()).toEqual([...VISIT_COLUMNS, 'deletedAt', 'deletedById'].sort());
    expect(findPeople).toHaveBeenCalledWith({ where: { id: { in: [9] } }, select: { id: true, name: true } });
    const body = await res.json();
    expect(body.visits.Person).toEqual([{ id: 9, name: 'Bo Board' }]);
    expect(body.visits.Visit[0]).toMatchObject({ id: 1, deletedById: 9, deletedAt: deletedAt.toISOString() });
});

it('the live list answers a bare array and never reads removers', async () => {
    findMany.mockResolvedValue([{ id: 1, personId: 2 }]);

    const body = await (await GET(req())).json();

    expect(body.visits).toEqual([{ id: 1, personId: 2 }]);
    expect(findMany.mock.calls[0][0].where).toEqual({ deletedAt: null });
    expect(findPeople).not.toHaveBeenCalled();
});
