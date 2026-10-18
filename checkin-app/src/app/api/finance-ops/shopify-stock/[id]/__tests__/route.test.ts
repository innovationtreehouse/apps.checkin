/**
 * @jest-environment node
 */
/**
 * The board's unconfirmed Shopify stock screen: GET lists parked stock changes,
 * POST settles one. Board only (others 403); "landed" clears the amount with no
 * Shopify call; "notLanded" moves it back into the owed carry; a changed amount
 * is refused as stale; each settle writes an AuditLog row with the actor.
 */
import type { NextRequest } from 'next/server';
import { getServerSession } from 'next-auth/next';
import prisma from '@/lib/prisma';
import { GET } from '../../route';
import { POST } from '../route';

jest.mock('next-auth/next', () => ({ getServerSession: jest.fn() }));
jest.mock('@/lib/auth-options', () => ({ authOptions: {} }));

// One in-memory Program row with Prisma's increment / where semantics.
jest.mock('@/lib/prisma', () => {
    type Row = Record<string, unknown>;
    const state: { row: Row | null } = { row: null };
    const matches = (row: Row, where: Row) => Object.entries(where).every(([k, v]) => {
        if (k === 'OR') {
            const until = row.shopifyStockLeaseUntil as Date | null;
            return until === null || until < ((v as Row[])[1].shopifyStockLeaseUntil as { lt: Date }).lt;
        }
        return row[k] === v;
    });
    const apply = (row: Row, data: Row) => {
        for (const [k, v] of Object.entries(data)) {
            row[k] = v !== null && typeof v === 'object' && 'increment' in (v as Row) ? (row[k] as number) + (v as { increment: number }).increment : v;
        }
    };
    const db = {
        __state: state,
        program: {
            updateMany: jest.fn(async ({ where, data }: { where: Row; data: Row }) => {
                if (!state.row || !matches(state.row, where)) return { count: 0 };
                apply(state.row, data);
                return { count: 1 };
            }),
            findUniqueOrThrow: jest.fn(async () => ({ ...state.row })),
            findMany: jest.fn(async () => (state.row && (state.row.shopifyStockUnconfirmed !== 0 || state.row.shopifyStockParked) ? [{ ...state.row }] : [])),
            count: jest.fn(async ({ where }: { where: Row }) => (state.row && state.row.id === where.id ? 1 : 0)),
        },
        auditLog: { create: jest.fn() },
        $transaction: jest.fn(),
    };
    db.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) => cb(db));
    return { __esModule: true, default: db };
});

const db = prisma as unknown as {
    __state: { row: Record<string, unknown> | null };
    auditLog: { create: jest.Mock };
};
const mockSession = getServerSession as jest.Mock;
const BOARD = { user: { id: 9, isBoardMember: true } };

function post(body: unknown, id = '42'): Promise<Response> {
    const req = new Request(`http://localhost/api/finance-ops/shopify-stock/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    }) as unknown as NextRequest;
    return POST(req, { params: Promise.resolve({ id }) });
}

let fetchSpy: jest.SpyInstance;
beforeEach(() => {
    jest.clearAllMocks();
    db.__state.row = {
        id: 42, name: 'Robotics', shopifyVariantId: '67890',
        shopifyStockUnconfirmed: -2, shopifyStockParked: null, shopifyStockCarry: 1,
        shopifyStockLeaseUntil: null, shopifyStockLeaseToken: null,
    };
    fetchSpy = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('no network in tests'));
    mockSession.mockResolvedValue(BOARD);
});
afterEach(() => fetchSpy.mockRestore());

describe('access', () => {
    it.each([
        ['a plain member', { user: { id: 5 } }],
        ['a sysadmin', { user: { id: 5, isSysadmin: true } }],
        ['finance', { user: { id: 5, isFinance: true } }],
    ])('403s %s on both routes and changes nothing', async (_who, session) => {
        mockSession.mockResolvedValue(session);
        expect((await GET(new Request('http://localhost/api/finance-ops/shopify-stock') as unknown as NextRequest)).status).toBe(403);
        expect((await post({ choice: 'landed', expected: -2 })).status).toBe(403);
        expect(db.__state.row?.shopifyStockUnconfirmed).toBe(-2);
        expect(db.auditLog.create).not.toHaveBeenCalled();
    });

    it('401s an anonymous caller', async () => {
        mockSession.mockResolvedValue(null);
        expect((await post({ choice: 'landed', expected: -2 })).status).toBe(401);
    });
});

it('GET lists an amount the previous release parked as one row with no time', async () => {
    const res = await GET(new Request('http://localhost/api/finance-ops/shopify-stock') as unknown as NextRequest);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{
        programId: 42, programName: 'Robotics', unconfirmed: -2, carry: 1,
        unconfirmedSince: null, shopifyAvailable: null,
    }]);
});

it('GET lists each parked write as its own row, with when it was parked', async () => {
    db.__state.row!.shopifyStockUnconfirmed = 0;
    db.__state.row!.shopifyStockParked = JSON.stringify([
        { key: 'k-a', delta: -1, parkedAt: '2026-10-12T10:00:00.000Z' },
        { key: 'k-b', delta: 1, parkedAt: '2026-10-13T10:00:00.000Z' },
    ]);
    const res = await GET(new Request('http://localhost/api/finance-ops/shopify-stock') as unknown as NextRequest);
    expect((await res.json()).map((r: { unconfirmed: number; unconfirmedSince: string }) => [r.unconfirmed, r.unconfirmedSince])).toEqual([
        [-1, '2026-10-12T10:00:00.000Z'],
        [1, '2026-10-13T10:00:00.000Z'],
    ]);
});

it('"Shopify has it" clears the amount, audits it, releases the lease and calls no Shopify', async () => {
    const res = await post({ choice: 'landed', expected: -2 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ programId: 42, choice: 'landed', amount: -2, carry: 1 });
    expect(db.__state.row).toMatchObject({ shopifyStockUnconfirmed: 0, shopifyStockCarry: 1, shopifyStockLeaseToken: null, shopifyStockLeaseUntil: null });
    expect(db.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({
        actorId: 9, action: 'EDIT', tableName: 'Program', affectedEntityId: 42,
        newData: expect.objectContaining({ settledUnconfirmedStock: 'landed', amount: -2 }),
    }) });
    expect(fetchSpy).not.toHaveBeenCalled();
});

it('"Shopify doesn\'t have it" moves the amount back into the carry and audits it', async () => {
    // No variant: nothing to nudge, so the test sees only the bookkeeping.
    db.__state.row!.shopifyVariantId = null;
    const res = await post({ choice: 'notLanded', expected: -2 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ programId: 42, choice: 'notLanded', amount: -2, carry: -1 });
    expect(db.__state.row).toMatchObject({ shopifyStockUnconfirmed: 0, shopifyStockCarry: -1, shopifyStockLeaseToken: null });
    expect(db.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({
        actorId: 9, affectedEntityId: 42,
        newData: expect.objectContaining({ settledUnconfirmedStock: 'notLanded', amount: -2, shopifyStockCarry: -1 }),
    }) });
});

it('refuses a stale amount with 409 and changes nothing', async () => {
    const res = await post({ choice: 'notLanded', expected: -1 });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/changed since the page loaded/);
    expect(db.__state.row).toMatchObject({ shopifyStockUnconfirmed: -2, shopifyStockCarry: 1, shopifyStockLeaseToken: null });
    expect(db.auditLog.create).not.toHaveBeenCalled();
});

it('refuses while a stock push holds the lease', async () => {
    db.__state.row!.shopifyStockLeaseUntil = new Date(Date.now() + 60_000);
    db.__state.row!.shopifyStockLeaseToken = 'pusher';
    const res = await post({ choice: 'landed', expected: -2 });
    expect(res.status).toBe(409);
    expect(db.__state.row).toMatchObject({ shopifyStockUnconfirmed: -2, shopifyStockLeaseToken: 'pusher' });
});

it('rejects a bad choice or a zero amount', async () => {
    expect((await post({ choice: 'maybe', expected: -2 })).status).toBe(400);
    expect((await post({ choice: 'landed', expected: 0 })).status).toBe(400);
});
