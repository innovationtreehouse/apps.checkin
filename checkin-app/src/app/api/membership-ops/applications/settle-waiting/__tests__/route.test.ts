/**
 * @jest-environment node
 */
/**
 * POST /api/membership-ops/applications/settle-waiting: a Board click settles every application
 * waiting on its check once, answers the counts only, and leaves one audit row naming who ran it,
 * written through recordAudit inside a transaction.
 * Auth runs through the real handler; only next-auth's getServerSession is stubbed.
 */
import type { NextRequest as NextRequestType } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { settleApplicationsAwaitingCheck } from '@/lib/membership/settleHouseholdBg';
import { POST } from '../route';

jest.mock('@/lib/membership/settleHouseholdBg', () => ({ settleApplicationsAwaitingCheck: jest.fn() }));

const mockAuditCreate = jest.fn();
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: { $transaction: jest.fn((fn: (tx: unknown) => unknown) => fn({ auditLog: { create: mockAuditCreate } })) },
}));

const { NextRequest } = jest.requireActual<{ NextRequest: typeof NextRequestType }>('next/server');
const mockSession = getServerSession as jest.MockedFunction<typeof getServerSession>;
const settle = jest.mocked(settleApplicationsAwaitingCheck);
const auditCreate = mockAuditCreate;

function signIn(claims: Record<string, boolean>) {
    mockSession.mockResolvedValue({
        user: {
            id: 5,
            isSysadmin: false,
            isBoardMember: false,
            isKeyholder: false,
            isBackgroundCheckReviewer: false,
            isOperations: false,
            isInventoryManager: false,
            isFinance: false,
            ...claims,
        },
        expires: '2099-01-01',
    });
}

const press = () => POST(new NextRequest('http://localhost/api/membership-ops/applications/settle-waiting', { method: 'POST' }));

beforeEach(() => {
    mockSession.mockReset();
    settle.mockReset();
    auditCreate.mockReset().mockResolvedValue({});
});

afterEach(() => jest.restoreAllMocks());

describe('POST /api/membership-ops/applications/settle-waiting', () => {
    it('settles once for the Board, answers the counts only, and audits who ran it', async () => {
        signIn({ isBoardMember: true });
        settle.mockResolvedValue({ households: 7, opened: 5, failed: 1 });

        const res = await press();

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ households: 7, opened: 5, failed: 1 });
        expect(settle).toHaveBeenCalledTimes(1);
        expect(settle).toHaveBeenCalledWith('a Board fix-pending-checks click');
        expect(auditCreate).toHaveBeenCalledTimes(1);
        expect(auditCreate).toHaveBeenCalledWith({
            data: {
                actorId: 5,
                actorSystem: null,
                action: 'EDIT',
                tableName: 'APPLICATION_SETTLE_SWEEP',
                affectedEntityId: 0,
                newData: { households: 7, opened: 5, failed: 1 },
            },
        });
    });

    it.each([
        ['a sysadmin off the board', { isSysadmin: true }],
        ['a background-check reviewer', { isBackgroundCheckReviewer: true }],
        ['a person with no role', {}],
    ])('403s %s without settling or auditing', async (_who, claims) => {
        signIn(claims);

        const res = await press();

        expect(res.status).toBe(403);
        expect(settle).not.toHaveBeenCalled();
        expect(auditCreate).not.toHaveBeenCalled();
    });

    it('401s with no session', async () => {
        mockSession.mockResolvedValue(null);

        const res = await press();

        expect(res.status).toBe(401);
        expect(settle).not.toHaveBeenCalled();
    });

    it('answers 500 with no audit row when the sweep itself throws', async () => {
        signIn({ isBoardMember: true });
        settle.mockRejectedValue(new Error('db down'));
        jest.spyOn(console, 'error').mockImplementation(() => {});

        const res = await press();

        expect(res.status).toBe(500);
        expect(auditCreate).not.toHaveBeenCalled();
    });
});
