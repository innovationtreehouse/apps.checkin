/**
 * @jest-environment node
 */
/**
 * POST /api/system-status/problems/retry: one press retries one listed item through its library,
 * answers `{ results: [{ step, id, ok }] }` with the library's status, never error text, and
 * leaves one audit row naming who pressed. Auth runs through the real handler; only next-auth's
 * getServerSession is stubbed (jest.setup.js mocks it).
 */
import type { NextRequest as NextRequestType } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { ServiceError } from '@checkin/component-kit';
import prisma from '@/lib/prisma';
import { retryProblem } from '@/lib/problems';
import { POST } from '../route';

jest.mock('@/lib/problems', () => ({ retryProblem: jest.fn() }));

const { NextRequest } = jest.requireActual<{ NextRequest: typeof NextRequestType }>('next/server');
const mockSession = getServerSession as jest.MockedFunction<typeof getServerSession>;
const retry = jest.mocked(retryProblem);
const auditCreate = jest.fn();

const ITEM = { library: 'receipt', step: 'flow', id: 'r1' };

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

const press = (body: unknown = ITEM) =>
    POST(new NextRequest('http://localhost/api/system-status/problems/retry', { method: 'POST', body: JSON.stringify(body) }));

beforeEach(() => {
    mockSession.mockReset();
    retry.mockReset();
    auditCreate.mockReset().mockResolvedValue({});
    prisma.auditLog.create = auditCreate as unknown as typeof prisma.auditLog.create;
});

afterEach(() => jest.restoreAllMocks());

describe('POST /api/system-status/problems/retry', () => {
    it.each([
        ['a sysadmin', { isSysadmin: true }],
        ['BOARD', { isBoardMember: true }],
    ])('lets %s retry an item and answers ok', async (_who, claims) => {
        signIn(claims);
        retry.mockResolvedValue();

        const res = await press();

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ results: [{ step: 'flow', id: 'r1', ok: true }] });
        expect(retry).toHaveBeenCalledTimes(1);
        expect(retry).toHaveBeenCalledWith(ITEM);
    });

    it.each([
        ['FINANCE', { isFinance: true }],
        ['an inventory manager', { isInventoryManager: true }],
        ['an operations volunteer', { isOperations: true }],
        ['a person with no role', {}],
    ])('403s %s without retrying or auditing', async (_who, claims) => {
        signIn(claims);

        const res = await press();

        expect(res.status).toBe(403);
        expect(retry).not.toHaveBeenCalled();
        expect(auditCreate).not.toHaveBeenCalled();
    });

    it.each([
        ['expense', 'QuickBooks posting'],
        ['expense', 'QuickBooks processing'],
        ['gifts', 'QuickBooks posting'],
    ])('403s a sysadmin retrying %s %s, a QuickBooks step, without retrying or auditing', async (library, step) => {
        signIn({ isSysadmin: true });

        const res = await press({ library, step, id: 'e1' });

        expect(res.status).toBe(403);
        expect(retry).not.toHaveBeenCalled();
        expect(auditCreate).not.toHaveBeenCalled();
    });

    it('lets BOARD retry a QuickBooks step', async () => {
        signIn({ isBoardMember: true });
        retry.mockResolvedValue();

        const res = await press({ library: 'gifts', step: 'QuickBooks posting', id: 'receipt 4' });

        expect(res.status).toBe(200);
        expect(retry).toHaveBeenCalledTimes(1);
    });

    it("lets a sysadmin retry a step that does not post to QuickBooks", async () => {
        signIn({ isSysadmin: true });
        retry.mockResolvedValue();

        const res = await press({ library: 'expense', step: 'intake', id: 'r2' });

        expect(res.status).toBe(200);
        expect(retry).toHaveBeenCalledWith({ library: 'expense', step: 'intake', id: 'r2' });
    });

    it.each([404, 409, 503])('answers %i with ok false and no error text when the library refuses', async (status) => {
        signIn({ isBoardMember: true });
        retry.mockRejectedValue(new ServiceError(status, 'The gift for Pat Example was not posted'));

        const res = await press();

        expect(res.status).toBe(status);
        const text = await res.text();
        expect(JSON.parse(text)).toEqual({ results: [{ step: 'flow', id: 'r1', ok: false }] });
        expect(text).not.toMatch(/Pat|posted/);
    });

    it('records who pressed, the item and the outcome', async () => {
        signIn({ isBoardMember: true });
        retry.mockRejectedValue(new ServiceError(409, 'failed again'));

        await press();

        expect(auditCreate).toHaveBeenCalledTimes(1);
        expect(auditCreate.mock.calls[0][0].data).toEqual({
            actorId: 5,
            actorSystem: null,
            action: 'CREATE',
            tableName: 'PROBLEM_RETRY',
            affectedEntityId: 0,
            newData: { library: 'receipt', step: 'flow', id: 'r1', ok: false },
        });
    });

    it('answers an opaque 500, logged and audited, when the retry throws anything else', async () => {
        signIn({ isBoardMember: true });
        const logged = jest.spyOn(console, 'error').mockImplementation(() => {});
        retry.mockRejectedValue(new Error('connection to Pat Example lost'));

        const res = await press();

        expect(res.status).toBe(500);
        expect(await res.text()).not.toMatch(/Pat/);
        expect(logged).toHaveBeenCalled();
        expect(auditCreate.mock.calls[0][0].data.newData).toMatchObject({ ok: false });
    });

    it.each([
        ['no step', { library: 'expense', id: 'e1' }],
        ['a numeric id', { library: 'expense', step: 'intake', id: 7 }],
        ['no body', null],
    ])('400s a body with %s without retrying', async (_what, body) => {
        signIn({ isSysadmin: true });

        const res = await press(body);

        expect(res.status).toBe(400);
        expect(retry).not.toHaveBeenCalled();
    });
});
