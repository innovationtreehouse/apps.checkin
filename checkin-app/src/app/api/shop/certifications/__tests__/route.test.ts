/**
 * @jest-environment node
 */
/**
 * GET /api/shop/certifications through the real handler(): each view selects
 * only the cert, tool and person columns the certification pages read.
 * POST: the active-member-family checks on the certifier and the target.
 */
import type { NextRequest } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { isActiveOrgMember } from '@/lib/orgMembership';
import { GET, POST } from '../route';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));
jest.mock('@/lib/orgMembership', () => ({ isActiveOrgMember: jest.fn() }));
jest.mock('@/lib/membership/selfGrantGuard', () => ({
    refuseSelfGrant: jest.fn().mockResolvedValue(false),
    SELF_GRANT_REFUSAL_MESSAGE: 'self grant refused',
}));
jest.mock('@/lib/getKioskCertifications', () => ({ invalidateKioskCertificationsCache: jest.fn() }));
jest.mock('@/lib/logger', () => ({ logBackendError: jest.fn() }));

const findMany = jest.fn();
const findUnique = jest.fn();
const personFindUnique = jest.fn();
const tx = {
    toolStatus: {
        findUnique: jest.fn(),
        updateMany: jest.fn(),
        createMany: jest.fn(),
        findUniqueOrThrow: jest.fn(),
    },
    auditLog: { create: jest.fn() },
};
const transaction = jest.fn();
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        toolStatus: {
            findMany: (...a: unknown[]) => findMany(...a),
            findUnique: (...a: unknown[]) => findUnique(...a),
        },
        person: { findUnique: (...a: unknown[]) => personFindUnique(...a) },
        $transaction: (...a: unknown[]) => transaction(...a),
    },
}));

const mockSession = jest.mocked(getServerSession);
const mockIsActiveOrgMember = jest.mocked(isActiveOrgMember);
const req = (query: string) => new Request(`http://localhost/api/shop/certifications${query}`) as unknown as NextRequest;
const CERT_KEYS = ['level', 'person', 'personId', 'tool', 'toolId'];
const TOOL_SELECT = { select: { id: true, name: true } };
const PERSON_SELECT = { select: { id: true, name: true } };

const CERTIFIER_ID = 5;
const TARGET_ID = 9;
const TOOL_ID = 7;
const CERTIFIER_REFUSAL = 'Forbidden: certifier must belong to an active member family';
const TARGET_REFUSAL = 'Forbidden: target must belong to an active member family';

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

describe('POST active-member-family checks', () => {
    const post = () => POST(new Request('http://localhost/api/shop/certifications', {
        method: 'POST',
        body: JSON.stringify({ personId: TARGET_ID, toolId: TOOL_ID, level: 'CERTIFIED' }),
    }));
    const signInAs = (roles: { isSysadmin?: boolean; isBoardMember?: boolean }) =>
        mockSession.mockResolvedValue({ user: { id: CERTIFIER_ID, isSysadmin: false, isBoardMember: false, ...roles } });
    const activeMembers = (...ids: number[]) =>
        mockIsActiveOrgMember.mockImplementation(async (id: number) => ids.includes(id));
    const expectNoToolStatusWrite = () => {
        expect(transaction).not.toHaveBeenCalled();
        expect(tx.toolStatus.updateMany).not.toHaveBeenCalled();
        expect(tx.toolStatus.createMany).not.toHaveBeenCalled();
    };

    beforeEach(() => {
        personFindUnique.mockResolvedValue({ householdId: 3 });
        findUnique.mockResolvedValue({ personId: CERTIFIER_ID, toolId: TOOL_ID, level: 'MAY_CERTIFY_OTHERS' });
        tx.toolStatus.findUnique.mockResolvedValue(null);
        tx.toolStatus.createMany.mockResolvedValue({ count: 1 });
        tx.toolStatus.findUniqueOrThrow.mockResolvedValue({ personId: TARGET_ID, toolId: TOOL_ID, level: 'CERTIFIED' });
        transaction.mockImplementation(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx));
    });

    it('refuses a tool certifier outside an active member family', async () => {
        signInAs({});
        activeMembers(TARGET_ID);

        const res = await post();

        expect(res.status).toBe(403);
        expect(await res.json()).toMatchObject({ error: CERTIFIER_REFUSAL });
        expect(mockIsActiveOrgMember).toHaveBeenCalledWith(CERTIFIER_ID);
        expectNoToolStatusWrite();
    });

    it.each([
        ['sysadmin', { isSysadmin: true }],
        ['Board member', { isBoardMember: true }],
    ])('lets a %s outside an active member family certify a member', async (_label, roles) => {
        signInAs(roles);
        activeMembers(TARGET_ID);

        const res = await post();

        expect(res.status).toBe(200);
        expect(mockIsActiveOrgMember).not.toHaveBeenCalledWith(CERTIFIER_ID);
        expect(tx.toolStatus.createMany).toHaveBeenCalledWith({
            data: { personId: TARGET_ID, toolId: TOOL_ID, level: 'CERTIFIED' },
            skipDuplicates: true,
        });
    });

    it.each([
        ['sysadmin', { isSysadmin: true }],
        ['Board member', { isBoardMember: true }],
        ['tool certifier', {}],
    ])('refuses a target outside an active member family for a %s', async (_label, roles) => {
        signInAs(roles);
        activeMembers(CERTIFIER_ID);

        const res = await post();

        expect(res.status).toBe(403);
        expect(await res.json()).toMatchObject({ error: TARGET_REFUSAL });
        expect(mockIsActiveOrgMember).toHaveBeenCalledWith(TARGET_ID);
        expectNoToolStatusWrite();
    });
});
