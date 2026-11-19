/**
 * @jest-environment node
 */
jest.mock('@/lib/auth', () => ({
    withAuth: (_opts: unknown, handler: (req: Request, auth: unknown) => unknown) =>
        (req: Request, auth: unknown) => handler(req, auth),
}));

import { GET } from '../route';
import prisma from '@/lib/prisma';

const AUTH = { type: 'session', user: { id: 9, isSysadmin: false, isBoardMember: false } };
const get = () =>
    (GET as unknown as (req: Request, auth: unknown) => Promise<Response>)(new Request('http://localhost/api/shop/tools'), AUTH);

it('selects only the tool columns and cert count the tool lists read', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    prisma.tool.findMany = findMany;

    expect((await get()).status).toBe(200);

    const args = findMany.mock.calls[0][0];
    expect(args).not.toHaveProperty('include');
    expect(args.select).toEqual({ id: true, name: true, safetyGuide: true, _count: { select: { toolStatuses: true } } });
});
