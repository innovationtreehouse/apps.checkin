/**
 * @jest-environment node
 */
/**
 * GET /api/shop/certifications through the real handler(): each view selects
 * only the cert, tool and person columns the certification pages read.
 */
import type { NextRequest } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { GET } from '../route';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));

const findMany = jest.fn();
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: { toolStatus: { findMany: (...a: unknown[]) => findMany(...a) } },
}));

const mockSession = jest.mocked(getServerSession);
const req = (query: string) => new Request(`http://localhost/api/shop/certifications${query}`) as unknown as NextRequest;
const CERT_KEYS = ['level', 'person', 'personId', 'tool', 'toolId'];
const TOOL_SELECT = { select: { id: true, name: true } };
const PERSON_SELECT = { select: { id: true, name: true } };

beforeEach(() => {
    jest.clearAllMocks();
    mockSession.mockResolvedValue({ user: { id: 5, isSysadmin: false, isBoardMember: true } });
    findMany.mockResolvedValue([]);
});

it.each([
    ['all assignments', '?all=true', PERSON_SELECT],
    ['one tool', '?toolId=7', PERSON_SELECT],
    ['one person', '?personId=9', false],
])('selects only the read columns for %s', async (_label, query, person) => {
    expect((await GET(req(query))).status).toBe(200);

    const args = findMany.mock.calls[0][0];
    expect(args).not.toHaveProperty('include');
    expect(Object.keys(args.select).sort()).toEqual(CERT_KEYS);
    expect(args.select.tool).toEqual(TOOL_SELECT);
    expect(args.select.person).toEqual(person);
});
