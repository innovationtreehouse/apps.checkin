/**
 * @jest-environment node
 */
import type { NextRequest } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { GET, PUT } from '../route';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));

const tx = {
    boardSettings: { upsert: jest.fn(), update: jest.fn() },
    auditLog: { create: jest.fn() },
};
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        boardSettings: { upsert: jest.fn() },
        $transaction: jest.fn((fn: (t: unknown) => unknown) => fn(tx)),
    },
}));

const asUser = (user: { isSysadmin: boolean; isBoardMember: boolean } | null) =>
    (getServerSession as jest.Mock).mockResolvedValue(user && { user: { id: 7, ...user } });

const board = { isSysadmin: false, isBoardMember: true };

// handler() only reads url + json() off the request.
const put = (body: unknown) =>
    PUT(new Request('http://localhost/api/settings/quickbooks', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
    }) as unknown as NextRequest);

beforeEach(() => {
    jest.clearAllMocks();
    tx.boardSettings.upsert.mockResolvedValue({ qboProductionRealmId: '111' });
    tx.boardSettings.update.mockImplementation(({ data }) => Promise.resolve(data));
    asUser(board);
});

describe('PUT /api/settings/quickbooks', () => {
    it('saves the realm and audits who changed it, old and new', async () => {
        const res = await put({ qboProductionRealmId: ' 222 ' });
        expect(res.status).toBe(200);
        expect((await res.json()).settings).toEqual({ qboProductionRealmId: '222' });
        expect(tx.auditLog.create).toHaveBeenCalledWith({
            data: {
                actorId: 7,
                action: 'EDIT',
                tableName: 'BoardSettings',
                affectedEntityId: 1,
                oldData: { qboProductionRealmId: '111' },
                newData: { qboProductionRealmId: '222' },
            },
        });
    });

    it('clears to null on blank or null, turning QuickBooks off', async () => {
        for (const value of ['', '  ', null]) {
            expect((await put({ qboProductionRealmId: value })).status).toBe(200);
            expect(tx.boardSettings.update).toHaveBeenLastCalledWith(expect.objectContaining({ data: { qboProductionRealmId: null } }));
        }
    });

    it('rejects a non-numeric id, a wrong type, or bad JSON without writing', async () => {
        for (const body of [{ qboProductionRealmId: '12a' }, { qboProductionRealmId: 12 }, {}, 'not json']) {
            expect((await put(body)).status).toBe(400);
        }
        expect(tx.boardSettings.update).not.toHaveBeenCalled();
        expect(tx.auditLog.create).not.toHaveBeenCalled();
    });

    it('is Board only: anon 401, sysadmin and plain members 403', async () => {
        asUser(null);
        expect((await put({ qboProductionRealmId: '222' })).status).toBe(401);
        for (const user of [{ isSysadmin: true, isBoardMember: false }, { isSysadmin: false, isBoardMember: false }]) {
            asUser(user);
            expect((await put({ qboProductionRealmId: '222' })).status).toBe(403);
        }
        expect(tx.auditLog.create).not.toHaveBeenCalled();
    });
});

describe('GET /api/settings/quickbooks', () => {
    it('is Board only', async () => {
        asUser({ isSysadmin: true, isBoardMember: false });
        expect((await GET(new Request('http://localhost/api/settings/quickbooks') as unknown as NextRequest)).status).toBe(403);
    });
});
