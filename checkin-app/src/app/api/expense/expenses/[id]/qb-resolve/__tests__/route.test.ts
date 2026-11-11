/**
 * @jest-environment node
 */
/**
 * POST /api/expense/expenses/[id]/qb-resolve: FINANCE only. The library's route factory is mocked; its
 * write and audit row are covered in packages/expense's integration tests.
 */
import type { NextRequest } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { routes } from '@checkin/expense';
import { POST } from '../route';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));
jest.mock('@checkin/expense', () => ({
    routes: { finance: { qbResolve: jest.fn() } },
}));

const asUser = (isFinance: boolean) =>
    (getServerSession as jest.Mock).mockResolvedValue({
        user: { id: 7, isSysadmin: false, isBoardMember: false, isFinance, canAccessStaging: true },
    });

const post = () =>
    POST(
        new Request('http://localhost/api/expense/expenses/e1/qb-resolve', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', cookie: 'next-auth.session-token=x' },
            body: JSON.stringify({ action: 'skip', reason: 'booked by hand' }),
        }) as unknown as NextRequest,
        { params: Promise.resolve({ id: 'e1' }) },
    );

describe('POST /api/expense/expenses/[id]/qb-resolve', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        jest.mocked(routes.finance.qbResolve).mockResolvedValue({ Expense: { id: 'e1', qbMatchState: 'SKIPPED' } });
    });

    it('lets FINANCE reach the library', async () => {
        asUser(true);
        expect((await post()).status).toBe(200);
        expect(routes.finance.qbResolve).toHaveBeenCalledWith(expect.objectContaining({ params: { id: 'e1' } }));
    });

    it('refuses anyone else before the library', async () => {
        asUser(false);
        expect((await post()).status).toBe(403);
        expect(routes.finance.qbResolve).not.toHaveBeenCalled();
    });
});
