import { resetTokenCache, SHOPIFY_INVENTORY_API_VERSION } from '../shopify/client';
import { adjustProgramInventory, changeProgramStock, healProgramStock, listUnconfirmedStock, programStockTiming, setProgramInventory, settleUnconfirmedStock } from '../shopify/stock';
import { sendEmail } from '../email';
import prisma from '../prisma';

jest.mock('../email', () => ({ sendEmail: jest.fn().mockResolvedValue(true) }));
jest.mock('../logger', () => ({ logIntegrationError: jest.fn().mockResolvedValue(undefined) }));
// One in-memory Program row with Prisma's increment / where semantics, so tests
// assert the bookkeeping the writer leaves behind rather than call shapes.
jest.mock('../prisma', () => {
    type Row = Record<string, unknown>;
    const mockState: { row: Row | null; locked: boolean } = { row: null, locked: false };
    const apply = (row: Row, data: Row) => {
        for (const [k, v] of Object.entries(data)) {
            row[k] = v !== null && typeof v === 'object' && 'increment' in (v as Row)
                ? (row[k] as number) + ((v as { increment: number }).increment)
                : v;
        }
    };
    const matches = (row: Row, where: Row) => {
        if (where.id !== row.id) return false;
        if ('shopifyStockLeaseToken' in where && where.shopifyStockLeaseToken !== row.shopifyStockLeaseToken) return false;
        if (where.OR) {
            const until = row.shopifyStockLeaseUntil as Date | null;
            const now = ((where.OR as Row[])[1].shopifyStockLeaseUntil as { lt: Date }).lt;
            if (until !== null && until >= now) return false;
        }
        return true;
    };
    const client: Record<string, unknown> = {
            __state: mockState,
            // The Program row lock: recorded so a test can check what ran under it.
            $queryRaw: jest.fn(async () => { mockState.locked = true; return []; }),
            $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
                try { return await fn(client); } finally { mockState.locked = false; }
            }),
            program: {
                update: jest.fn(async ({ where, data }: { where: Row; data: Row }) => {
                    if (!mockState.row || where.id !== mockState.row.id) throw new Error('P2025');
                    apply(mockState.row, data);
                    return { ...mockState.row };
                }),
                updateMany: jest.fn(async ({ where, data }: { where: Row; data: Row }) => {
                    if (!mockState.row || !matches(mockState.row, where)) return { count: 0 };
                    apply(mockState.row, data);
                    return { count: 1 };
                }),
                findUnique: jest.fn(async () => (mockState.row ? { ...mockState.row } : null)),
                findUniqueOrThrow: jest.fn(async () => ({ ...mockState.row })),
                findMany: jest.fn(async () => (mockState.row ? [{ ...mockState.row, shopifyVariantId: '67890' }] : [])),
                count: jest.fn(async () => (mockState.row ? 1 : 0)),
            },
            person: { findMany: jest.fn(async () => [{ email: 'admin@test.com' }]) },
            integrationErrorLog: { findMany: jest.fn(async () => []) },
            auditLog: { create: jest.fn() },
    };
    return { __esModule: true, default: client };
});

const db = prisma as unknown as { __state: { row: Record<string, unknown> | null; locked: boolean }; person: { findMany: jest.Mock } };

type Vars = Record<string, unknown> & { idempotencyKey?: string; input?: { changes: { delta: number; changeFromQuantity: null }[] } };
type Reply = { status?: number; data?: unknown; errors?: unknown[]; unreadable?: boolean; delayMs?: number } | Error;
type Op = 'ProgramStockRead' | 'ProgramStockAdjust' | 'ProgramStockActivate';

const program = { id: 42, shopifyVariantId: '67890' };
const ITEM = 'gid://shopify/InventoryItem/111';
const LOC = 'gid://shopify/Location/555';

function readReply(available: number | null): Reply {
    return {
        data: {
            locations: { nodes: [{ id: 'gid://shopify/Location/1', isActive: false }, { id: LOC, isActive: true }] },
            productVariant: {
                inventoryItem: {
                    id: ITEM,
                    inventoryLevels: { nodes: available === null ? [] : [{ location: { id: LOC }, quantities: [{ quantity: available }] }] },
                },
            },
        },
    };
}
const adjustOk: Reply = { data: { inventoryAdjustQuantities: { inventoryAdjustmentGroup: { id: 'g' }, userErrors: [] } } };
const adjustUserError = (code: string): Reply => ({ data: { inventoryAdjustQuantities: { inventoryAdjustmentGroup: null, userErrors: [{ code, message: code }] } } });
const concurrent = () => Array.from({ length: 500 }, () => adjustUserError('IDEMPOTENCY_CONCURRENT_REQUEST'));
const timedOut = () => new Error('Shopify program stock timed out after 20000ms');

/** Route fetch: token exchange, then GraphQL replies queued per operation name. */
function shopify(replies: Partial<Record<Op, Reply[]>>) {
    const calls: { op: Op; url: string; variables: Vars }[] = [];
    global.fetch = jest.fn(async (url: string, init: RequestInit) => {
        if (url.includes('/oauth/access_token')) return { ok: true, status: 200, json: async () => ({ access_token: 't' }) };
        const { query, variables } = JSON.parse(init.body as string) as { query: string; variables: Vars };
        const op = (['ProgramStockRead', 'ProgramStockAdjust', 'ProgramStockActivate'] as const).find((o) => query.includes(o))!;
        calls.push({ op, url, variables });
        const reply = replies[op]?.shift();
        if (!reply) throw new Error(`unexpected ${op}`);
        if (reply instanceof Error) throw reply;
        if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
        const json = async () => {
            if (reply.unreadable) throw new SyntaxError('Unexpected end of JSON input');
            return { data: reply.data, errors: reply.errors };
        };
        return { ok: (reply.status ?? 200) < 400, status: reply.status ?? 200, json };
    }) as unknown as typeof fetch;
    return { calls, ops: () => calls.map((c) => c.op), adjusts: () => calls.filter((c) => c.op === 'ProgramStockAdjust') };
}

function setRow(over: Record<string, unknown> = {}) {
    db.__state.row = {
        id: 42, shopifyStockCarry: 0, shopifyStockPendingWrite: null, shopifyStockPushNeededAt: null,
        shopifyStockLeaseUntil: null, shopifyStockLeaseToken: null, shopifyStockUnconfirmed: 0, shopifyStockParked: null,
        name: 'Robotics', startAt: new Date('2099-01-01'), offSaleAt: null, saleEndedAt: null, ...over,
    };
}
/** The bookkeeping left on the program after the call. */
function after() {
    const r = db.__state.row!;
    return {
        carry: r.shopifyStockCarry,
        unconfirmed: r.shopifyStockUnconfirmed,
        parked: r.shopifyStockParked ? (JSON.parse(r.shopifyStockParked as string) as { key: string; delta: number }[]).map((w) => [w.key, w.delta]) : [],
        pending: r.shopifyStockPendingWrite ? JSON.parse(r.shopifyStockPendingWrite as string) : null,
        flagged: r.shopifyStockPushNeededAt instanceof Date,
        leased: r.shopifyStockLeaseToken !== null,
    };
}
const clean = { carry: 0, unconfirmed: 0, parked: [], pending: null, flagged: false, leased: false };
const emailed = (text: string) => expect(sendEmail).toHaveBeenCalledWith('admin@test.com', 'Shopify Integration Error', expect.stringContaining(text));
const pendingWrite = (over: Record<string, unknown> = {}) => JSON.stringify({
    key: 'program-42-comp-old', reason: 'comp', delta: -1, owedPart: -1, inventoryItemId: ITEM, locationId: LOC,
    sentAt: new Date().toISOString(), ...over,
});

const timing = { ...programStockTiming };
let originalEnv: NodeJS.ProcessEnv;
let spies: jest.SpyInstance[] = [];

beforeEach(() => {
    originalEnv = { ...process.env };
    process.env.CHECKIN_ENV = 'dev';
    process.env.SHOPIFY_STORE_DOMAIN = 'test.myshopify.com';
    process.env.SHOPIFY_CLIENT_ID = 'id';
    process.env.SHOPIFY_CLIENT_SECRET = 'secret';
    jest.clearAllMocks();
    setRow();
    resetTokenCache();
    Object.assign(programStockTiming, { capMs: 10_000, requestCapMs: 10_000, maxBackoffMs: 1 });
    spies = [jest.spyOn(console, 'log'), jest.spyOn(console, 'warn'), jest.spyOn(console, 'error')].map((s) => s.mockImplementation(() => {}));
});

afterEach(() => {
    process.env = originalEnv;
    Object.assign(programStockTiming, timing);
    spies.forEach((s) => s.mockRestore());
});

describe('adjustProgramInventory (the one program-stock writer)', () => {
    it('reads available and sends the owed delta as one keyed inventoryAdjustQuantities, then releases the lease', async () => {
        const s = shopify({ ProgramStockRead: [readReply(5)], ProgramStockAdjust: [adjustOk] });

        expect(await adjustProgramInventory(program, -1, 'comp')).toBe(true);

        const [adjust] = s.adjusts();
        expect(adjust.url).toContain(`/admin/api/${SHOPIFY_INVENTORY_API_VERSION}/graphql.json`);
        expect(SHOPIFY_INVENTORY_API_VERSION).toBe('2026-04');
        expect(adjust.variables.input!.changes[0]).toEqual({ inventoryItemId: ITEM, locationId: LOC, delta: -1, changeFromQuantity: null });
        expect(adjust.variables.idempotencyKey).toMatch(/^program-42-comp-[0-9a-f-]{36}$/);
        expect(after()).toEqual(clean);
        expect(sendEmail).not.toHaveBeenCalled();
    });

    it('resends the SAME request after a timeout, a 5xx and IDEMPOTENCY_CONCURRENT_REQUEST; the key dedupes it', async () => {
        const s = shopify({
            ProgramStockRead: [readReply(3)],
            ProgramStockAdjust: [timedOut(), { status: 502 }, adjustUserError('IDEMPOTENCY_CONCURRENT_REQUEST'), adjustOk],
        });

        expect(await adjustProgramInventory(program, 1, 'hold-release')).toBe(true);

        expect(s.adjusts()).toHaveLength(4);
        expect(new Set(s.adjusts().map((c) => JSON.stringify(c.variables))).size).toBe(1);
        expect(after()).toEqual(clean);
    });

    it('a timeout whose first attempt landed: the resend is the cached success, booked once (no unconfirmed)', async () => {
        // Shopify's reply to the resend of a landed write is its original success.
        const s = shopify({ ProgramStockRead: [readReply(5)], ProgramStockAdjust: [timedOut(), adjustOk] });

        expect(await adjustProgramInventory(program, -1, 'comp')).toBe(true);

        expect(s.adjusts()[0].variables.idempotencyKey).toBe(s.adjusts()[1].variables.idempotencyKey);
        expect(after()).toEqual(clean);
    });

    it('a hard error (also after a timeout: the key replays the original error) did not apply: the delta stays owed', async () => {
        const s = shopify({ ProgramStockRead: [readReply(1)], ProgramStockAdjust: [timedOut(), adjustUserError('INVALID_LOCATION')] });

        expect(await adjustProgramInventory(program, 1, 'hold-release')).toBe(false);

        expect(s.adjusts()).toHaveLength(2);
        expect(after()).toEqual({ ...clean, carry: 1, flagged: true });
        emailed('needs a push');
        expect(db.person.findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({ OR: expect.arrayContaining([{ isBoardMember: true }]) }),
        }));
    });

    it('hitting the cap leaves the write pending (resent later under its key), flags and alerts', async () => {
        programStockTiming.capMs = 30;
        programStockTiming.maxBackoffMs = 5;
        const s = shopify({ ProgramStockRead: [readReply(2)], ProgramStockAdjust: concurrent() });

        expect(await adjustProgramInventory(program, 1, 'hold-release')).toBe(false);

        expect(new Set(s.adjusts().map((c) => c.variables.idempotencyKey)).size).toBe(1);
        const a = after();
        expect(a).toMatchObject({ carry: 0, flagged: true, leased: false });
        expect(a.pending).toMatchObject({ key: s.adjusts()[0].variables.idempotencyKey, delta: 1, owedPart: 1 });
        emailed('needs a push');
    });

    it('settles a pending write under its own key first, then lands the new delta', async () => {
        setRow({ shopifyStockPendingWrite: pendingWrite(), shopifyStockPushNeededAt: new Date() });
        const s = shopify({ ProgramStockRead: [readReply(4)], ProgramStockAdjust: [adjustOk, adjustOk] });

        expect(await adjustProgramInventory(program, 1, 'hold-release')).toBe(true);

        expect(s.ops()).toEqual(['ProgramStockAdjust', 'ProgramStockRead', 'ProgramStockAdjust']);
        expect(s.calls[0].variables.idempotencyKey).toBe('program-42-comp-old');
        expect(s.calls[2].variables.input!.changes[0]).toMatchObject({ delta: 1 });
        expect(after()).toEqual(clean);
    });

    it('a pending write whose resend is refused did not apply: it is still owed and nets against the new delta', async () => {
        setRow({ shopifyStockPendingWrite: pendingWrite() });
        const s = shopify({ ProgramStockAdjust: [adjustUserError('INVALID_LOCATION')] });

        // −1 owed + this +1 = 0: nothing more to write.
        expect(await adjustProgramInventory(program, 1, 'hold-release')).toBe(false);

        expect(s.adjusts()).toHaveLength(1);
        expect(after()).toMatchObject({ carry: 0, unconfirmed: 0, pending: null, flagged: true });
    });

    it('a pending write older than the key lifetime is not resent: parked as unconfirmed, board told', async () => {
        setRow({ shopifyStockPendingWrite: pendingWrite({ sentAt: new Date(Date.now() - 25 * 60 * 60_000).toISOString() }) });
        const s = shopify({ ProgramStockRead: [readReply(4)], ProgramStockAdjust: [adjustOk] });

        expect(await adjustProgramInventory(program, 1, 'hold-release')).toBe(false);

        expect(s.calls[0].op).toBe('ProgramStockRead'); // the old key was never resent
        expect(after()).toEqual({ ...clean, parked: [['program-42-comp-old', -1]], flagged: true });
        emailed('could not say whether it landed');
    });

    it('activates an item not yet stocked at the location, then adds the initial stock', async () => {
        const s = shopify({
            ProgramStockRead: [readReply(null)],
            ProgramStockActivate: [{ data: { inventoryActivate: { inventoryLevel: { id: 'l' }, userErrors: [] } } }],
            ProgramStockAdjust: [adjustOk],
        });

        expect(await adjustProgramInventory(program, 10, 'initial-stock')).toBe(true);

        expect(s.ops()).toEqual(['ProgramStockRead', 'ProgramStockActivate', 'ProgramStockAdjust']);
        expect(s.calls[1].variables).toMatchObject({ inventoryItemId: ITEM, locationId: LOC, idempotencyKey: expect.stringMatching(/^program-42-activate-/) });
        expect(s.adjusts()[0].variables.input!.changes[0]).toMatchObject({ delta: 10 });
    });

    it('over capacity: takes stock only to 0, keeps the shortfall as a negative carry, flags and alerts', async () => {
        const s = shopify({ ProgramStockRead: [readReply(1)], ProgramStockAdjust: [adjustOk] });

        expect(await adjustProgramInventory(program, -3, 'activation')).toBe(true);

        expect(s.adjusts()[0].variables.input!.changes[0]).toMatchObject({ delta: -1 });
        expect(after()).toEqual({ ...clean, carry: -2, flagged: true });
        emailed('over capacity by 2');
    });

    it('over capacity: a later +1 pays down the shortfall and puts no seat on sale', async () => {
        setRow({ shopifyStockCarry: -2, shopifyStockPushNeededAt: new Date() });
        const s = shopify({ ProgramStockRead: [readReply(0)] });

        expect(await adjustProgramInventory(program, 1, 'hold-release')).toBe(true);

        expect(s.adjusts()).toHaveLength(0);
        expect(after()).toEqual({ ...clean, carry: -1, flagged: true });
        expect(sendEmail).not.toHaveBeenCalled();
    });

    it('over capacity: once the shortfall is paid, the rest goes on sale and the flag clears', async () => {
        setRow({ shopifyStockCarry: -1, shopifyStockPushNeededAt: new Date() });
        const s = shopify({ ProgramStockRead: [readReply(0)], ProgramStockAdjust: [adjustOk] });

        expect(await adjustProgramInventory(program, 3, 'capacity-edit')).toBe(true);

        expect(s.adjusts()[0].variables.input!.changes[0]).toMatchObject({ delta: 2 });
        expect(after()).toEqual(clean);
    });

    it('a busy lease: a request waits (no connection held) until its cap, then leaves the delta owed', async () => {
        programStockTiming.requestCapMs = 600;
        setRow({ shopifyStockLeaseUntil: new Date(Date.now() + 60_000), shopifyStockLeaseToken: 'other-writer' });
        const s = shopify({});

        expect(await adjustProgramInventory(program, -1, 'comp', { inRequest: true })).toBe(false);

        expect(s.calls).toHaveLength(0);
        expect(after()).toMatchObject({ carry: -1, flagged: true });
    });

    it('a busy lease that frees up within the cap: the waiting writer lands the delta', async () => {
        programStockTiming.requestCapMs = 5_000;
        setRow({ shopifyStockLeaseUntil: new Date(Date.now() + 300), shopifyStockLeaseToken: 'other-writer' });
        const s = shopify({ ProgramStockRead: [readReply(5)], ProgramStockAdjust: [adjustOk] });

        expect(await adjustProgramInventory(program, -1, 'comp', { inRequest: true })).toBe(true);

        expect(s.adjusts()).toHaveLength(1);
        expect(after()).toEqual(clean);
    });

    it('deferred (webhooks): records the delta and returns at once; the push lands in the background', async () => {
        const s = shopify({ ProgramStockRead: [readReply(5)], ProgramStockAdjust: [adjustOk] });

        expect(await adjustProgramInventory(program, 1, 'activation', { deferred: true })).toBe(true);
        expect(db.__state.row!.shopifyStockCarry).toBe(1);

        await new Promise((r) => setTimeout(r, 50));
        expect(s.adjusts()[0].variables.input!.changes[0]).toMatchObject({ delta: 1 });
        expect(after()).toEqual(clean);
    });

    it('missing credentials keep the delta owed, flag + alert, without any network call', async () => {
        delete process.env.SHOPIFY_STORE_DOMAIN;
        const fetchMock = jest.fn();
        global.fetch = fetchMock;

        expect(await adjustProgramInventory(program, -1, 'comp')).toBe(false);

        expect(fetchMock).not.toHaveBeenCalled();
        expect(after()).toMatchObject({ carry: -1, flagged: true });
        expect(sendEmail).toHaveBeenCalled();
    });

    it('changeProgramStock: a push that fails after recording is recorded but not landed', async () => {
        programStockTiming.capMs = 30;
        programStockTiming.maxBackoffMs = 5;
        shopify({ ProgramStockRead: [readReply(2)], ProgramStockAdjust: concurrent() });

        expect(await changeProgramStock(program, -1, 'comp')).toEqual({ recorded: true, landed: false });
    });

    it('changeProgramStock: a delta the DB could not record is neither', async () => {
        db.__state.row = null; // the record step's update fails
        shopify({});

        expect(await changeProgramStock(program, -1, 'comp')).toEqual({ recorded: false, landed: false });
        emailed('needs a push');
    });

    it('fails closed with no active location: nothing written, the delta stays owed', async () => {
        const noActive = readReply(5) as { data: { locations: { nodes: { isActive: boolean }[] } } };
        noActive.data.locations.nodes.forEach((l) => { l.isActive = false; });
        const s = shopify({ ProgramStockRead: [noActive] });

        expect(await adjustProgramInventory(program, -1, 'comp')).toBe(false);

        expect(s.adjusts()).toHaveLength(0);
        expect(after()).toMatchObject({ carry: -1, flagged: true });
        emailed('no active Shopify location');
    });

    it('after the sale has ended, an owed +1 is dropped instead of going back on sale', async () => {
        setRow({ saleEndedAt: new Date() });
        const s = shopify({ ProgramStockRead: [readReply(0)] });

        expect(await adjustProgramInventory(program, 1, 'hold-release')).toBe(true);

        expect(s.adjusts()).toHaveLength(0);
        expect(after()).toEqual(clean);
    });

    it('a pending +1 resent after the sale has ended lands, then goes straight back off sale', async () => {
        setRow({ saleEndedAt: new Date(), shopifyStockPendingWrite: pendingWrite({ key: 'program-42-hold-release-old', reason: 'hold-release', delta: 1, owedPart: 1 }) });
        const s = shopify({ ProgramStockAdjust: [adjustOk, adjustOk], ProgramStockRead: [readReply(1)] });

        expect(await healProgramStock()).toEqual({ checked: 1, settled: 1 });

        expect(s.adjusts()[0].variables.idempotencyKey).toBe('program-42-hold-release-old');
        expect(s.adjusts().map((c) => c.variables.input!.changes[0].delta)).toEqual([1, -1]);
        expect(after()).toEqual(clean);
    });

    it('a +1 in flight when the sale ends lands, then goes straight back off sale', async () => {
        const s = shopify({ ProgramStockRead: [readReply(0), readReply(1)], ProgramStockAdjust: [adjustOk, adjustOk] });
        const inner = global.fetch;
        global.fetch = jest.fn(async (url: string, init: RequestInit) => {
            const res = await inner(url, init);
            if (String(init.body).includes('ProgramStockAdjust')) db.__state.row!.saleEndedAt = new Date();
            return res;
        }) as unknown as typeof fetch;

        expect(await adjustProgramInventory(program, 1, 'hold-release')).toBe(true);

        expect(s.adjusts().map((c) => c.variables.input!.changes[0].delta)).toEqual([1, -1]);
        expect(after()).toEqual(clean);
    });

    it('setProgramInventory (re-arm) lands an absolute quantity as a delta, replacing deltas owed before it', async () => {
        setRow({ shopifyStockCarry: -2, shopifyStockPushNeededAt: new Date() });
        const s = shopify({ ProgramStockRead: [readReply(1), readReply(1)], ProgramStockAdjust: [adjustOk] });

        // The quantity is counted under the lease and the Program row lock that every
        // seat change takes with its carry change (F6, programs TLA+ model).
        const quantity = jest.fn(async () => {
            expect(db.__state.row!.shopifyStockLeaseToken).not.toBeNull();
            expect(db.__state.locked).toBe(true);
            return 4;
        });

        expect(await setProgramInventory(program, quantity, 're-arm')).toBe(true);

        expect(quantity).toHaveBeenCalledTimes(1);

        expect(s.adjusts()[0].variables.input!.changes[0]).toMatchObject({ delta: 3 });
        expect(s.adjusts()[0].variables.idempotencyKey).toMatch(/^program-42-re-arm-/);
        expect(after()).toEqual(clean);
    });

    it('setProgramInventory (re-arm) of an overfilled program holds stock at 0 and keeps the shortfall owed', async () => {
        const s = shopify({ ProgramStockRead: [readReply(1), readReply(1)], ProgramStockAdjust: [adjustOk] });

        // Capacity 3, 5 seats taken: 2 over.
        expect(await setProgramInventory(program, async () => 3 - 5, 're-arm')).toBe(true);

        expect(s.adjusts()[0].variables.input!.changes[0]).toMatchObject({ delta: -1 });
        expect(after()).toEqual({ ...clean, carry: -2, flagged: true });
    });

    it('a 200 whose body cannot be read is unsettled: resent under the SAME key, booked once', async () => {
        const s = shopify({ ProgramStockRead: [readReply(5)], ProgramStockAdjust: [{ unreadable: true }, adjustOk] });

        expect(await adjustProgramInventory(program, -1, 'comp')).toBe(true);

        expect(s.adjusts()).toHaveLength(2);
        expect(new Set(s.adjusts().map((c) => c.variables.idempotencyKey)).size).toBe(1);
        expect(after()).toEqual(clean);
    });

    it('a 401/403 after a timeout does not say the write missed: it stays pending under its key', async () => {
        programStockTiming.capMs = 30;
        programStockTiming.maxBackoffMs = 5;
        const s = shopify({
            ProgramStockRead: [readReply(5)],
            ProgramStockAdjust: [timedOut(), ...Array.from({ length: 500 }, (_, i): Reply => ({ status: i % 2 ? 401 : 403 }))],
        });

        expect(await adjustProgramInventory(program, -1, 'comp')).toBe(false);

        expect(new Set(s.adjusts().map((c) => c.variables.idempotencyKey)).size).toBe(1);
        const a = after();
        expect(a).toMatchObject({ carry: 0, flagged: true });
        expect(a.pending).toMatchObject({ key: s.adjusts()[0].variables.idempotencyKey, delta: -1 });
    });

    it('a 401 on the first attempt (nothing reached Shopify) did not apply: the delta stays owed', async () => {
        shopify({ ProgramStockRead: [readReply(5)], ProgramStockAdjust: [{ status: 401 }] });

        expect(await adjustProgramInventory(program, -1, 'comp')).toBe(false);

        expect(after()).toEqual({ ...clean, carry: -1, flagged: true });
    });

    it('stops at the top of the loop once the cap has passed, leaving the rest owed', async () => {
        programStockTiming.capMs = 50;
        setRow({ shopifyStockPendingWrite: pendingWrite() });
        const s = shopify({ ProgramStockAdjust: [{ ...(adjustOk as object), delayMs: 80 }] });

        expect(await adjustProgramInventory(program, 1, 'hold-release')).toBe(false);

        expect(s.ops()).toEqual(['ProgramStockAdjust']);
        expect(after()).toMatchObject({ carry: 1, pending: null, flagged: true, leased: false });
    });

    it('a multi-location store writes to the location that already stocks the item', async () => {
        const STOCKED = 'gid://shopify/Location/777';
        const s = shopify({
            ProgramStockRead: [{
                data: {
                    locations: { nodes: [{ id: LOC, isActive: true }, { id: STOCKED, isActive: true }] },
                    productVariant: { inventoryItem: { id: ITEM, inventoryLevels: { nodes: [{ location: { id: STOCKED }, quantities: [{ quantity: 3 }] }] } } },
                },
            }],
            ProgramStockAdjust: [adjustOk],
        });

        expect(await adjustProgramInventory(program, -1, 'comp')).toBe(true);

        expect(s.ops()).toEqual(['ProgramStockRead', 'ProgramStockAdjust']);
        expect(s.adjusts()[0].variables.input!.changes[0]).toMatchObject({ locationId: STOCKED, delta: -1 });
    });

    it('no variant or a zero delta is a no-op', async () => {
        const fetchMock = jest.fn();
        global.fetch = fetchMock;

        expect(await adjustProgramInventory({ id: 42, shopifyVariantId: null }, -3, 'comp')).toBe(true);
        expect(await adjustProgramInventory(program, 0, 'activation')).toBe(true);

        expect(fetchMock).not.toHaveBeenCalled();
        expect(after()).toEqual(clean);
    });

    it('CHECKIN_ENV=local runs the same leased path against the in-memory mock, no network', async () => {
        process.env.CHECKIN_ENV = 'local';
        const fetchMock = jest.fn();
        global.fetch = fetchMock;
        const local = { id: 42, shopifyVariantId: 'dev-mock-variant-local' };

        expect(await adjustProgramInventory(local, 5, 'initial-stock')).toBe(true);
        expect(await adjustProgramInventory(local, -1, 'comp')).toBe(true);

        expect(fetchMock).not.toHaveBeenCalled();
        expect(console.log).toHaveBeenCalledWith(expect.stringContaining('5 -> 4'));
        expect(after()).toEqual(clean);
    });
});

describe('healProgramStock (daily reconcile-shopify)', () => {
    it('lands what a program still owes and clears the flag', async () => {
        setRow({ shopifyStockCarry: 1, shopifyStockPushNeededAt: new Date() });
        const s = shopify({ ProgramStockRead: [readReply(2)], ProgramStockAdjust: [adjustOk] });

        expect(await healProgramStock()).toEqual({ checked: 1, settled: 1 });

        expect(s.adjusts()[0].variables.input!.changes[0]).toMatchObject({ delta: 1 });
        expect(s.adjusts()[0].variables.idempotencyKey).toMatch(/^program-42-heal-/);
        expect(after()).toEqual(clean);
    });

    it('resends a pending write under its key, then reverses it if the caller has since undone it', async () => {
        // A scholarship hold's −1 timed out and stayed pending; the hold was then withdrawn (+1 carry).
        setRow({ shopifyStockCarry: 1, shopifyStockPendingWrite: pendingWrite(), shopifyStockPushNeededAt: new Date() });
        const s = shopify({ ProgramStockAdjust: [adjustOk, adjustOk], ProgramStockRead: [readReply(2)] });

        expect(await healProgramStock()).toEqual({ checked: 1, settled: 1 });

        expect(s.adjusts()[0].variables.idempotencyKey).toBe('program-42-comp-old');
        expect(s.adjusts()[1].variables.input!.changes[0]).toMatchObject({ delta: 1 });
        expect(after()).toEqual(clean);
    });
});

describe('parked (unconfirmed) stock writes', () => {
    const DAY_AGO = () => new Date(Date.now() - 25 * 60 * 60_000).toISOString();

    /** The parked-at time the settle screen shows for a parked write. */
    const since = (key: string) => (JSON.parse(db.__state.row!.shopifyStockParked as string) as { key: string; parkedAt: string }[]).find((w) => w.key === key)!.parkedAt;

    /** Park the pending write on the row: a push finds it past its key's lifetime. */
    async function park(pending: string) {
        db.__state.row!.shopifyStockPendingWrite = pending;
        shopify({});
        await healProgramStock();
    }

    it('a single parked write is listed and settled on its own, as before', async () => {
        await park(pendingWrite({ sentAt: DAY_AGO() }));
        shopify({ ProgramStockRead: [readReply(3)] });

        expect(await listUnconfirmedStock()).toEqual([expect.objectContaining({ programId: 42, unconfirmed: -1, shopifyAvailable: 3 })]);
        expect(await settleUnconfirmedStock(42, -1, since('program-42-comp-old'), 'landed', 9)).toEqual({ carry: 0 });
        expect(after()).toMatchObject({ carry: 0, unconfirmed: 0, parked: [] });
    });

    it('two parked writes of opposite sign stay separate and are settled one by one (F5)', async () => {
        // A comp's −1 and its withdrawal's +1 each stay unsettled a day.
        await park(pendingWrite({ key: 'program-42-comp-a', delta: -1, owedPart: -1, sentAt: DAY_AGO() }));
        await park(pendingWrite({ key: 'program-42-comp-b', delta: 1, owedPart: 1, sentAt: DAY_AGO() }));
        expect(after().parked).toEqual([['program-42-comp-a', -1], ['program-42-comp-b', 1]]);

        shopify({ ProgramStockRead: [readReply(3)] });
        expect((await listUnconfirmedStock()).map((r) => r.unconfirmed)).toEqual([-1, 1]);

        // The board finds the −1 landed and the +1 did not: one seat is owed back.
        expect(await settleUnconfirmedStock(42, -1, since('program-42-comp-a'), 'landed', 9)).toEqual({ carry: 0 });
        db.__state.row!.shopifyVariantId = null; // nothing to nudge
        expect(await settleUnconfirmedStock(42, 1, since('program-42-comp-b'), 'notLanded', 9)).toEqual({ carry: 1 });
        expect(after()).toMatchObject({ carry: 1, parked: [] });
    });

    it('a re-arm sets the store from scratch, which resolves parked writes: a later "not landed" is refused (F7)', async () => {
        // A withdrawn hold's +1 never landed and was parked.
        await park(pendingWrite({ key: 'program-42-release', delta: 1, owedPart: 1, sentAt: DAY_AGO() }));
        expect(after().parked).toEqual([['program-42-release', 1]]);

        const parkedAt = since('program-42-release');
        // The board reopens: 4 seats free, the store shows 3 (the +1 is not there).
        const s = shopify({ ProgramStockRead: [readReply(3), readReply(4)], ProgramStockAdjust: [adjustOk] });
        expect(await setProgramInventory(program, async () => 4, 're-arm')).toBe(true);
        expect(s.adjusts()[0].variables.input!.changes[0]).toMatchObject({ delta: 1 });
        expect(after()).toEqual(clean);

        expect(await settleUnconfirmedStock(42, 1, parkedAt, 'notLanded', 9)).toEqual({ refused: 'stale' });
        expect(after()).toEqual(clean);
    });

    it('a re-arm that parks and clears a write in the same push reports success and asks the board for nothing', async () => {
        setRow({ shopifyStockPendingWrite: pendingWrite({ sentAt: DAY_AGO() }) });
        shopify({ ProgramStockRead: [readReply(3), readReply(4)], ProgramStockAdjust: [adjustOk] });

        expect(await setProgramInventory(program, async () => 4, 're-arm')).toBe(true);

        expect(after()).toEqual(clean);
        expect(sendEmail).not.toHaveBeenCalled();
    });

    it('two writes parked in the same millisecond still get distinct parked-at times', async () => {
        const now = jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-18T10:00:00.000Z'));
        await park(pendingWrite({ key: 'program-42-x', sentAt: '2026-10-17T00:00:00.000Z' }));
        await park(pendingWrite({ key: 'program-42-y', sentAt: '2026-10-17T00:00:00.000Z' }));
        now.mockRestore();
        expect(since('program-42-x')).not.toBe(since('program-42-y'));
    });

    it('the previous release\'s amount is settled by amount, apart from a parked write of the same amount', async () => {
        setRow({ shopifyStockUnconfirmed: -1 });
        await park(pendingWrite({ key: 'program-42-new', sentAt: DAY_AGO() }));

        expect(await settleUnconfirmedStock(42, -1, null, 'landed', 9)).toEqual({ carry: 0 });
        expect(after()).toMatchObject({ unconfirmed: 0, parked: [['program-42-new', -1]] });
    });
});
