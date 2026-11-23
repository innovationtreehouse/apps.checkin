/**
 * @jest-environment node
 */
/**
 * The QuickBooks posting slot: one run at a time, a busy slot queues the lane, the run that
 * releases starts the oldest queued lane, a yield re-queues, and a stranded queue restarts on a request.
 */
import type { PostingTurn } from '@checkin/quickbooks';
import { runExpenseQbPosting } from '@checkin/expense';
import { runInKindQbPosting } from '@checkin/bulk-donation';
import { drainIncomeOutbox } from '@checkin/income';
import { catchUpPosting, postingCatchUpState, postingSlotStatus, requestPostingRun, runPostingQueue } from '../quickBooksPosting';

interface SlotRow { orgId: string; holder: string | null; runId: string | null; until: Date; lastRuns: Record<string, unknown> | null }
interface QueueRow { id: number; orgId: string; lane: string; requestedById: number | null; requestedAt: Date }

const slots = new Map<string, SlotRow>();
let queue: QueueRow[] = [];
let nextId = 1;
let clock = 0;
const audits: unknown[] = [];

jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        quickBooksPostingSlot: {
            createMany: async ({ data }: { data: { orgId: string; until: Date }[] }) => {
                for (const d of data) if (!slots.has(d.orgId)) slots.set(d.orgId, { holder: null, runId: null, lastRuns: null, ...d });
                return { count: data.length };
            },
            updateMany: async ({ where, data }: { where: { orgId: string; runId?: string; until?: { lt: Date } }; data: Partial<SlotRow> }) => {
                const row = slots.get(where.orgId);
                if (!row) return { count: 0 };
                if (where.runId !== undefined && row.runId !== where.runId) return { count: 0 };
                if (where.until && !(row.until < where.until.lt)) return { count: 0 };
                Object.assign(row, data);
                return { count: 1 };
            },
            findUnique: async ({ where }: { where: { orgId: string } }) => slots.get(where.orgId) ?? null,
        },
        quickBooksPostingQueue: {
            upsert: async ({ create }: { create: { orgId: string; lane: string; requestedById: number | null } }) => {
                const found = queue.find((q) => q.orgId === create.orgId && q.lane === create.lane);
                if (found) return found;
                const row = { id: nextId++, requestedAt: new Date(++clock), ...create };
                queue.push(row);
                return row;
            },
            findMany: async ({ where }: { where: { orgId: string } }) =>
                queue.filter((q) => q.orgId === where.orgId).sort((a, b) => a.requestedAt.getTime() - b.requestedAt.getTime() || a.id - b.id),
            deleteMany: async ({ where }: { where: { id?: number; orgId?: string; lane?: string } }) => {
                const before = queue.length;
                queue = queue.filter((q) => !(where.id !== undefined ? q.id === where.id : q.orgId === where.orgId && q.lane === where.lane));
                return { count: before - queue.length };
            },
        },
        auditLog: { create: async ({ data }: { data: unknown }) => audits.push(data) },
    },
}));
jest.mock('@/lib/components/host', () => ({ getOrg: jest.fn().mockResolvedValue({ id: 'org-1', name: 'Org' }) }));
jest.mock('@checkin/expense', () => ({ runExpenseQbPosting: jest.fn() }));
jest.mock('@checkin/bulk-donation', () => ({ runInKindQbPosting: jest.fn() }));
jest.mock('@checkin/income', () => ({ drainIncomeOutbox: jest.fn() }));

const expense = jest.mocked(runExpenseQbPosting);
const inKind = jest.mocked(runInKindQbPosting);
const income = jest.mocked(drainIncomeOutbox);
const EXPENSE_RESULT = { stranded: { checked: 0, failed: 0 }, qbPost: 'unbound' as const, qbDrift: 'unbound' as const, outcomeNotices: { sent: 0, failed: 0 }, failedParts: [] };

/** Lets background chains run to their end. */
const settle = async () => {
    for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
};

beforeEach(() => {
    slots.clear();
    queue = [];
    audits.length = 0;
    jest.clearAllMocks();
    expense.mockResolvedValue(EXPENSE_RESULT);
    inKind.mockResolvedValue('unbound');
    income.mockResolvedValue({ reconcile: { status: 'unbound' }, post: 'unbound' });
    jest.spyOn(console, 'info').mockImplementation(() => {});
});

it('a free slot starts the lane and releases it with the run recorded', async () => {
    const run = await requestPostingRun('expense', null);
    expect(run.status).toBe('started');
    if (run.status === 'started') expect(await run.done).toBe(EXPENSE_RESULT);
    await settle();

    const slot = slots.get('org-1');
    expect(slot?.until.getTime()).toBe(0);
    expect(slot?.runId).toBeNull();
    expect(slot?.lastRuns).toMatchObject({ expense: { ended: 'done' } });
});

it('a held slot queues another lane once, and leaves the running lane alone', async () => {
    let finish: () => void = () => {};
    expense.mockImplementation(() => new Promise((r) => (finish = () => r(EXPENSE_RESULT))));
    await requestPostingRun('expense', null);

    const first = await requestPostingRun('in-kind', 7);
    const again = await requestPostingRun('in-kind', 8);
    const same = await requestPostingRun('expense', 9);

    expect(first).toMatchObject({ status: 'queued', slot: { heldBy: 'expense', queued: ['in-kind'] } });
    expect(again.status).toBe('queued');
    expect(same.status).toBe('running');
    expect(queue).toEqual([expect.objectContaining({ lane: 'in-kind', requestedById: 7 })]);
    expect(inKind).not.toHaveBeenCalled();

    finish();
    await settle();
    expect(inKind).toHaveBeenCalledTimes(1);
    expect(queue).toEqual([]);
    expect(slots.get('org-1')?.until.getTime()).toBe(0);
});

it('each renew extends the slot; a run whose slot another run took cannot renew', async () => {
    let turn: PostingTurn | undefined;
    expense.mockImplementation(async (t) => {
        turn = t;
        return EXPENSE_RESULT;
    });
    const run = await requestPostingRun('expense', null);
    if (run.status === 'started') await run.done;
    await settle();

    slots.set('org-1', { orgId: 'org-1', holder: 'income', runId: 'someone-else', until: new Date(Date.now() + 60_000), lastRuns: null });
    expect(await turn?.renew()).toBe(false);
});

it('a lane that yields to a throttle queues again behind the rest and does not loop', async () => {
    expense.mockImplementation(async (turn) => {
        if (turn) turn.yielded = true;
        return EXPENSE_RESULT;
    });
    const run = await requestPostingRun('expense', null);
    if (run.status === 'started') await run.done;
    await settle();

    expect(expense).toHaveBeenCalledTimes(1);
    expect(queue.map((q) => q.lane)).toEqual(['expense']);
    expect(slots.get('org-1')?.lastRuns).toMatchObject({ expense: { ended: 'yielded' } });
});

it("a crashed run frees the slot; a stranded queue restarts with finance's catch-up, the asker's lane first", async () => {
    expense.mockRejectedValueOnce(new Error('db down'));
    const crashed = await requestPostingRun('expense', null);
    if (crashed.status === 'started') await expect(crashed.done).rejects.toThrow('db down');
    await settle();
    expect(slots.get('org-1')?.lastRuns).toMatchObject({ expense: { ended: 'crashed' } });

    // A run that died without releasing: the slot has lapsed and a lane waits.
    slots.set('org-1', { orgId: 'org-1', holder: 'in-kind', runId: 'dead', until: new Date(Date.now() - 1), lastRuns: null });
    queue.push({ id: nextId++, orgId: 'org-1', lane: 'income', requestedById: null, requestedAt: new Date(++clock) });
    expect(await postingCatchUpState('expense')).toMatchObject({ status: 'stranded', heldBy: null, queued: ['income'] });

    const order: string[] = [];
    expense.mockImplementation(async () => (order.push('expense'), EXPENSE_RESULT));
    income.mockImplementation(async () => (order.push('income'), { reconcile: { status: 'unbound' }, post: 'unbound' }));
    const answer = await catchUpPosting('expense', 7);
    await settle();

    expect(answer).toMatchObject({ lane: 'expense', status: 'started' });
    expect(audits).toEqual([expect.objectContaining({ actorId: 7, tableName: 'QuickBooksPostingQueue', newData: { lane: 'expense', request: 'catch-up' } })]);
    expect(order).toEqual(['expense', 'income']);
    expect(queue).toEqual([]);
});

it('the daily run starts lanes still queued while the slot is free', async () => {
    queue.push({ id: nextId++, orgId: 'org-1', lane: 'in-kind', requestedById: 3, requestedAt: new Date(++clock) });
    await runPostingQueue();
    expect(inKind).toHaveBeenCalledWith('org-1', expect.any(Date), expect.objectContaining({ yielded: false }));
    expect(queue).toEqual([]);
});

it("reads a lane's place: running, queued, idle", async () => {
    slots.set('org-1', { orgId: 'org-1', holder: 'expense', runId: 'r', until: new Date(Date.now() + 60_000), lastRuns: null });
    queue.push({ id: nextId++, orgId: 'org-1', lane: 'income', requestedById: null, requestedAt: new Date(++clock) });

    expect((await postingCatchUpState('expense')).status).toBe('running');
    expect((await postingCatchUpState('income')).status).toBe('queued');
    expect(await postingCatchUpState('in-kind')).toMatchObject({ lane: 'in-kind', status: 'idle', heldBy: 'expense', queued: ['income'] });
    expect(await postingCatchUpState(null)).toMatchObject({ lane: null, status: 'running', heldBy: 'expense', queued: ['income'] });
});

const run = async (lane: 'expense' | 'in-kind' | 'income') => {
    const started = await requestPostingRun(lane, null);
    if (started.status === 'started') await started.done.catch(() => {});
    await settle();
};

it("records each run's counts, and counts yields in a row until a clean end", async () => {
    income.mockResolvedValue({ reconcile: { status: 'unbound' }, post: { posted: 100, matched: 2, queued: 0, failed: 0, throttled: 0, waiting: 0, over_cap: 0, held: 0, capped: 'count' } });
    await run('income');
    expect(slots.get('org-1')?.lastRuns).toMatchObject({ income: { ended: 'done', created: 100, matched: 2, capped: 'count', yieldsInRow: 0 } });

    expense.mockImplementation(async (turn) => {
        if (turn) turn.yielded = true;
        return EXPENSE_RESULT;
    });
    for (let i = 0; i < 3; i++) {
        queue = [];
        await run('expense');
    }
    expect(slots.get('org-1')?.lastRuns).toMatchObject({ expense: { ended: 'yielded', created: 0, capped: null, yieldsInRow: 3 } });
    expect((await postingSlotStatus()).warnings).toEqual([expect.objectContaining({ lane: 'expense', cause: 'throttled' })]);

    expense.mockResolvedValue(EXPENSE_RESULT);
    queue = [];
    await run('expense');
    expect(slots.get('org-1')?.lastRuns).toMatchObject({ expense: { ended: 'done', yieldsInRow: 0 } });
    expect((await postingSlotStatus()).warnings).toEqual([]);
});

it('a run that lapsed holding the slot is recorded as expired by the next taker, once', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    slots.set('org-1', { orgId: 'org-1', holder: 'in-kind', runId: 'dead', until: new Date('2026-11-18T14:05:00Z'), lastRuns: { 'in-kind': { endedAt: 'x', ended: 'yielded', yieldsInRow: 1 } } });
    await run('expense');
    await run('income');

    expect(slots.get('org-1')?.lastRuns).toMatchObject({ 'in-kind': { ended: 'expired', endedAt: '2026-11-18T14:05:00.000Z', yieldsInRow: 1 } });
    const status = await postingSlotStatus();
    expect(status.warnings).toEqual([expect.objectContaining({ lane: 'in-kind', cause: 'expired' })]);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('qb_slot_expired'))).toHaveLength(1);
});

it('the System Status read names who asked for each waiting lane, and the request count', async () => {
    slots.set('org-1', { orgId: 'org-1', holder: 'expense', runId: 'r', until: new Date(Date.now() + 60_000), lastRuns: null });
    queue.push({ id: nextId++, orgId: 'org-1', lane: 'income', requestedById: 7, requestedAt: new Date(++clock) });
    expect(await postingSlotStatus()).toMatchObject({
        heldBy: 'expense',
        pausedUntil: null,
        waiting: [{ lane: 'income', requestedById: 7 }],
        requestsToday: expect.any(Number),
    });
});
