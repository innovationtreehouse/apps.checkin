/**
 * @jest-environment node
 */
/**
 * PUT /api/expense/expenses/[id]/test-data: FINANCE only, and absent outside dev and local. The library's route
 * factory is mocked; its write and audit row are covered in packages/expense's integration tests.
 */
import type { NextRequest } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { routes } from '@inventory/expense';
import { PUT } from '../route';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));
jest.mock('@inventory/expense', () => ({
    ExpenseHttpError: class ExpenseHttpError extends Error {},
    routes: { expenses: { testData: jest.fn() } },
}));

// canAccessStaging and the cookie get a browser session past the stg gate and local's keyless-kiosk path.
const asUser = (isFinance: boolean) =>
    (getServerSession as jest.Mock).mockResolvedValue({
        user: { id: 7, isSysadmin: false, isBoardMember: false, isFinance, canAccessStaging: true },
    });

const put = () =>
    PUT(
        new Request('http://localhost/api/expense/expenses/e1/test-data', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', cookie: 'next-auth.session-token=x' },
            body: JSON.stringify({ isTestData: true }),
        }) as unknown as NextRequest,
        { params: Promise.resolve({ id: 'e1' }) },
    );

describe('PUT /api/expense/expenses/[id]/test-data', () => {
    const prev = process.env.CHECKIN_ENV;

    beforeEach(() => {
        jest.clearAllMocks();
        jest.mocked(routes.expenses.testData).mockResolvedValue({ Expense: { id: 'e1', isTestData: true } });
    });

    afterAll(() => {
        if (prev === undefined) delete process.env.CHECKIN_ENV;
        else process.env.CHECKIN_ENV = prev;
    });

    it.each(['prod', 'stg', '', undefined, 'DEV'])('answers 404 for CHECKIN_ENV=%p without reaching the library', async (env) => {
        if (env === undefined) delete process.env.CHECKIN_ENV;
        else process.env.CHECKIN_ENV = env;
        asUser(true);
        expect((await put()).status).toBe(404);
        expect(routes.expenses.testData).not.toHaveBeenCalled();
    });

    it.each(['dev', 'local'])('lets FINANCE set it on %s', async (env) => {
        process.env.CHECKIN_ENV = env;
        asUser(true);
        const res = await put();
        expect(res.status).toBe(200);
        expect(routes.expenses.testData).toHaveBeenCalledWith(expect.objectContaining({ params: { id: 'e1' } }));
    });

    it('refuses anyone without FINANCE with 403', async () => {
        process.env.CHECKIN_ENV = 'dev';
        asUser(false);
        expect((await put()).status).toBe(403);
        expect(routes.expenses.testData).not.toHaveBeenCalled();
    });
});
