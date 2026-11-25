/**
 * @jest-environment node
 */
/**
 * The reimbursee and QuickBooks Vendor reads on an expense through checkin's handler(): FINANCE
 * alone is admitted, and every other caller is refused before the expense library runs. The
 * library is stubbed; its own tests cover the reads against a real database.
 */
import type { NextRequest as NextRequestType } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { routes } from '@checkin/expense';
import type { AuthenticatedUser } from '@/types/auth';
import { GET as reimburseeOptions } from '../expenses/[id]/reimbursee/options/route';
import { GET as reimburseeVendor } from '../expenses/[id]/reimbursee-vendor/route';
import { GET as reimburseeVendorOptions } from '../expenses/[id]/reimbursee-vendor/options/route';

jest.mock('@checkin/expense', () => ({
    routes: { expenses: { reimburseePeople: jest.fn(), reimburseeVendor: jest.fn(), linkVendor: jest.fn(), reimburseeVendorOptions: jest.fn() } },
}));

const { NextRequest } = jest.requireActual<{ NextRequest: typeof NextRequestType }>('next/server');

type Read = typeof reimburseeVendor;

const member: Partial<AuthenticatedUser> = {
    id: 5, email: 'member@x.test', isSysadmin: false, isBoardMember: false, isFinance: false, isKeyholder: false, programsLed: [], householdId: 7,
};
const FINANCE = { ...member, isFinance: true };

type Factory = jest.MockedFunction<typeof routes.expenses.reimburseeVendor>;

const READS: Array<[string, Read, Factory, Record<string, unknown>]> = [
    ['reimbursee/options', reimburseeOptions, jest.mocked(routes.expenses.reimburseePeople), { ExpenseReimburseeView: [] }],
    ['reimbursee-vendor', reimburseeVendor, jest.mocked(routes.expenses.reimburseeVendor), { ExpenseReimburseeVendor: null, ExpenseReimburseeView: null }],
    ['reimbursee-vendor/options', reimburseeVendorOptions, jest.mocked(routes.expenses.reimburseeVendorOptions), { ExpenseQbVendorOption: [] }],
];

async function get(read: Read, path: string, user: Partial<AuthenticatedUser> | null) {
    jest.mocked(getServerSession).mockResolvedValueOnce(user && { user, expires: '2099-01-01T00:00:00.000Z' });
    const req = new NextRequest(`http://localhost/api/expense/expenses/e-1/${path}?q=Pat`);
    return read(req, { params: Promise.resolve({ id: 'e-1' }) });
}

beforeEach(() => {
    for (const [, , factory, bag] of READS) factory.mockReset().mockResolvedValue(bag);
});

describe.each(READS)('GET /api/expense/expenses/[id]/%s', (path, read, factory) => {
    test('no session is refused with 401 before the library runs', async () => {
        expect((await get(read, path, null)).status).toBe(401);
        expect(factory).not.toHaveBeenCalled();
    });

    test.each([
        ['a member', member],
        ['the Board', { ...member, isBoardMember: true }],
        ['a sysadmin', { ...member, isSysadmin: true }],
        ['a keyholder', { ...member, isKeyholder: true }],
    ])('%s is refused with 403 before the library runs', async (_who, user) => {
        expect((await get(read, path, user)).status).toBe(403);
        expect(factory).not.toHaveBeenCalled();
    });

    test('FINANCE is admitted', async () => {
        expect((await get(read, path, FINANCE)).status).toBe(200);
        expect(factory).toHaveBeenCalledWith(expect.objectContaining({ params: { id: 'e-1' } }));
    });
});
