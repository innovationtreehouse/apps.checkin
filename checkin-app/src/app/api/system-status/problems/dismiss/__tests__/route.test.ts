/**
 * @jest-environment node
 */
/**
 * POST /api/system-status/problems/dismiss: one press takes one listed item off the Problems list for
 * whoever may retry it and answers `{ results: [{ step, id, ok }] }`; dismissProblem writes the audit row.
 * Auth runs through the real handler; only next-auth's getServerSession is stubbed.
 */
import type { NextRequest as NextRequestType } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { ServiceError } from '@checkin/component-kit';
import { dismissProblem } from '@/lib/problems';
import { POST } from '../route';

jest.mock('@/lib/problems', () => ({ dismissProblem: jest.fn() }));

const { NextRequest } = jest.requireActual<{ NextRequest: typeof NextRequestType }>('next/server');
const mockSession = getServerSession as jest.MockedFunction<typeof getServerSession>;
const dismiss = jest.mocked(dismissProblem);

const ITEM = { library: 'receipt', step: 'flow', id: 'r1' };
const MAIL = { library: 'receipt', step: 'mail message', id: '12' };

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
    POST(new NextRequest('http://localhost/api/system-status/problems/dismiss', { method: 'POST', body: JSON.stringify(body) }));

beforeEach(() => {
    mockSession.mockReset();
    dismiss.mockReset();
});

describe('POST /api/system-status/problems/dismiss', () => {
    it.each([
        ['a sysadmin', { isSysadmin: true }],
        ['BOARD', { isBoardMember: true }],
    ])('lets %s dismiss an item as themself and answers ok', async (_who, claims) => {
        signIn(claims);
        dismiss.mockResolvedValue();

        const res = await press();

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ results: [{ step: 'flow', id: 'r1', ok: true }] });
        expect(dismiss).toHaveBeenCalledWith(ITEM, { userId: 5 });
    });

    it('lets BOARD dismiss a captured email', async () => {
        signIn({ isBoardMember: true });
        dismiss.mockResolvedValue();

        expect((await press(MAIL)).status).toBe(200);
        expect(dismiss).toHaveBeenCalledWith(MAIL, { userId: 5 });
    });

    it.each([
        ['receipt', 'mail message'],
        ['expense', 'QuickBooks posting'],
        ['gifts', 'QuickBooks posting'],
    ])('403s a sysadmin dismissing %s %s, a Board-only step, without dismissing', async (library, step) => {
        signIn({ isSysadmin: true });

        const res = await press({ library, step, id: '12' });

        expect(res.status).toBe(403);
        expect(dismiss).not.toHaveBeenCalled();
    });

    it.each([
        ['FINANCE', { isFinance: true }],
        ['a person with no role', {}],
    ])('403s %s without dismissing', async (_who, claims) => {
        signIn(claims);

        expect((await press()).status).toBe(403);
        expect(dismiss).not.toHaveBeenCalled();
    });

    it('answers 404, with no library text, for an item not on the list', async () => {
        signIn({ isBoardMember: true });
        dismiss.mockRejectedValue(new ServiceError(404, 'No such item for Pat Example'));

        const res = await press();

        expect(res.status).toBe(404);
        expect(await res.text()).not.toMatch(/Pat/);
    });

    it.each([
        ['a library that cannot be read', new ServiceError(503, 'Database for Pat Example unavailable')],
        ['anything else', new Error('connection to Pat Example lost')],
    ])('answers an opaque 500, logged with no error text, for %s', async (_what, err) => {
        signIn({ isBoardMember: true });
        const logged = jest.spyOn(console, 'error').mockImplementation(() => {});
        dismiss.mockRejectedValue(err);

        const res = await press();

        expect(res.status).toBe(500);
        expect(await res.text()).not.toMatch(/Pat/);
        expect(logged).toHaveBeenCalled();
        expect(JSON.stringify(logged.mock.calls, (_k, v: unknown) => (v instanceof Error ? v.message : v))).not.toMatch(/Pat/);
        logged.mockRestore();
    });

    it('400s a malformed body without dismissing', async () => {
        signIn({ isSysadmin: true });

        expect((await press({ library: 'expense', id: 'e1' })).status).toBe(400);
        expect(dismiss).not.toHaveBeenCalled();
    });
});
