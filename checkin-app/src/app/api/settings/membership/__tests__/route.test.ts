/**
 * @jest-environment node
 */
import { PUT } from '../route';
import { getServerSession } from 'next-auth/next';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));

const tx = {
    boardSettings: { upsert: jest.fn(), findUniqueOrThrow: jest.fn() },
    $executeRaw: jest.fn(),
    auditLog: { create: jest.fn() },
};
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: { $transaction: jest.fn((fn: (t: unknown) => unknown) => fn(tx)) },
}));

function asUser(user: { isSysadmin: boolean; isBoardMember: boolean }) {
    (getServerSession as jest.Mock).mockResolvedValue({ user: { id: 7, ...user } });
}
const put = (body: unknown) =>
    PUT(new Request('http://localhost:4000/api/settings/membership', { method: 'PUT', body: JSON.stringify(body) }));

describe('PUT /api/settings/membership releaseLibrary', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        tx.boardSettings.findUniqueOrThrow.mockResolvedValue({ id: 1, releasedLibraries: ['catalog', 'expense'] });
        asUser({ isSysadmin: false, isBoardMember: true });
    });

    it('merges the delta into the stored list in one statement and audits the delta', async () => {
        const res = await put({ releaseLibrary: { library: 'expense', released: true } });
        expect(res.status).toBe(200);
        expect((await res.json()).settings.releasedLibraries).toEqual(['catalog', 'expense']);

        expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
        const [sql, ...values] = tx.$executeRaw.mock.calls[0];
        expect(sql.join('?')).toMatch(/UPDATE "BoardSettings" SET "releasedLibraries"/);
        expect(values).toEqual(expect.arrayContaining(['expense', true]));
        expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ newData: { releaseLibrary: { library: 'expense', released: true } } }),
        }));
    });

    it('rejects a full-list write, bad keys, and non-board members', async () => {
        expect((await put({ releasedLibraries: ['catalog'] })).status).toBe(400);
        expect((await put({ releaseLibrary: { library: 'nope', released: true } })).status).toBe(400);
        expect((await put({ releaseLibrary: { library: 'catalog', released: 'yes' } })).status).toBe(400);
        asUser({ isSysadmin: true, isBoardMember: false });
        expect((await put({ releaseLibrary: { library: 'catalog', released: true } })).status).toBe(403);
        expect(tx.$executeRaw).not.toHaveBeenCalled();
    });
});
