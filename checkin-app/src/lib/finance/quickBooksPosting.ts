import { randomUUID } from "node:crypto";
import prisma from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { getOrg } from "@/lib/components/host";
import { logger } from "@/lib/logger";
import { personActor } from "@/lib/auditActor";
import { qbPacer, type PostingTurn } from "@checkin/quickbooks";
import { runExpenseQbPosting } from "@checkin/expense";
import { runInKindQbPosting } from "@checkin/bulk-donation";
import { drainIncomeOutbox } from "@checkin/income";
import { NO_COUNTS, isPostingLane, postingWarnings, readLastRuns, type LastRun, type LastRuns, type PostingLane, type PostingWarning, type RunCounts, type RunEnd } from "@/lib/finance/postingRuns";

export { isPostingLane, type PostingLane } from "@/lib/finance/postingRuns";

// One QuickBooks posting run at a time per org (the posting slot), and the lanes waiting their turn.
// A run renews the slot before each record; one that crashes or hangs frees it when `until` passes.

const SLOT_MS = 5 * 60_000;

interface LaneResults {
    expense: Awaited<ReturnType<typeof runExpenseQbPosting>>;
    "in-kind": Awaited<ReturnType<typeof runInKindQbPosting>>;
    income: Awaited<ReturnType<typeof drainIncomeOutbox>>;
}

const LANE_RUNS: { [L in PostingLane]: (turn: PostingTurn) => Promise<LaneResults[L]> } = {
    expense: (turn) => runExpenseQbPosting(turn),
    "in-kind": async (turn) => runInKindQbPosting((await getOrg()).id, new Date(), turn),
    income: async (turn) => drainIncomeOutbox((await getOrg()).id, new Date(), turn),
};

const LANE_COUNTS: { [L in PostingLane]: (result: LaneResults[L]) => RunCounts } = {
    expense: ({ qbPost: p }) => (typeof p === "object" && !("error" in p) ? { created: p.posted, matched: p.matched, capped: p.capped } : NO_COUNTS),
    "in-kind": (r) => (typeof r === "object" && !("unconfigured" in r) ? { created: r.posted, matched: r.matched, capped: r.capped ? "count" : null } : NO_COUNTS),
    income: ({ post: p }) => (typeof p === "object" ? { created: p.posted, matched: p.matched, capped: p.capped } : NO_COUNTS),
};

export interface PostingSlotState {
    /** The lane holding the slot now; null while it is free. */
    heldBy: PostingLane | null;
    until: Date | null;
    /** The lanes waiting, oldest first. */
    queued: PostingLane[];
    /** When this process's QuickBooks throttle pause ends; null when none is in force. */
    pausedUntil: Date | null;
    lastRuns: LastRuns;
}

/** The QuickBooksPostingCatchUp response: a lane's place relative to the slot, and the slot itself. */
export interface PostingCatchUp extends PostingSlotState {
    /** Null when the slot was read without a lane. */
    lane: PostingLane | null;
    /** POST: started, queued or running; GET: running, queued, stranded (the slot is free and lanes wait) or idle. */
    status: "started" | "queued" | "running" | "stranded" | "idle";
}

export type PostingRun<T> = { status: "started"; done: Promise<T> } | { status: "queued" | "running"; slot: PostingSlotState };

function readQueue(orgId: string) {
    return prisma.quickBooksPostingQueue.findMany({ where: { orgId }, orderBy: [{ requestedAt: "asc" }, { id: "asc" }], select: { lane: true, requestedById: true, requestedAt: true } });
}

function stateOf(slot: { holder: string | null; until: Date; lastRuns: Prisma.JsonValue } | null, queue: { lane: string }[]): PostingSlotState {
    const live = slot && slot.until.getTime() > Date.now() && isPostingLane(slot.holder) ? { lane: slot.holder, until: slot.until } : null;
    return {
        heldBy: live?.lane ?? null,
        until: live?.until ?? null,
        queued: queue.map((q) => q.lane).filter(isPostingLane),
        pausedUntil: qbPacer.pauseEnds(),
        lastRuns: readLastRuns(slot?.lastRuns),
    };
}

async function slotState(orgId: string): Promise<PostingSlotState> {
    const [slot, queue] = await Promise.all([prisma.quickBooksPostingSlot.findUnique({ where: { orgId } }), readQueue(orgId)]);
    return stateOf(slot, queue);
}

export interface PostingSlotStatus extends PostingSlotState {
    waiting: { lane: PostingLane; requestedById: number | null; requestedAt: Date }[];
    warnings: PostingWarning[];
    /** This process's QuickBooks requests this UTC day. */
    requestsToday: number;
}

/** The slot for System Status: its state, who asked for each waiting lane and when, the lanes' warnings, and today's request count. */
export async function postingSlotStatus(): Promise<PostingSlotStatus> {
    const orgId = (await getOrg()).id;
    const [slot, queue] = await Promise.all([prisma.quickBooksPostingSlot.findUnique({ where: { orgId } }), readQueue(orgId)]);
    const state = stateOf(slot, queue);
    const waiting = queue.flatMap((w) => (isPostingLane(w.lane) ? [{ lane: w.lane, requestedById: w.requestedById, requestedAt: w.requestedAt }] : []));
    return { ...state, waiting, warnings: postingWarnings(state.lastRuns), requestsToday: qbPacer.requestsToday() };
}

/** Records a run that lapsed while still holding the slot as its lane's last run, `expired`; once, by whichever taker gets there first. */
async function recordExpired(orgId: string, now: Date): Promise<void> {
    const slot = await prisma.quickBooksPostingSlot.findUnique({ where: { orgId }, select: { holder: true, runId: true, until: true, lastRuns: true } });
    if (!slot?.runId || slot.until >= now || !isPostingLane(slot.holder)) return;
    const runs = readLastRuns(slot.lastRuns);
    const prev = runs[slot.holder];
    const expired: LastRun = { ...NO_COUNTS, yieldsInRow: prev?.yieldsInRow ?? 0, endedAt: slot.until.toISOString(), ended: "expired" };
    const { count: won } = await prisma.quickBooksPostingSlot.updateMany({ where: { orgId, runId: slot.runId }, data: { runId: null, lastRuns: { ...runs, [slot.holder]: expired } } });
    if (won === 1) logger.warn("[quickbooks] qb_slot_expired", { lane: slot.holder });
}

/** Takes the org's slot for `lane` unless a live run holds it. */
async function takeSlot(orgId: string, lane: PostingLane, runId: string): Promise<boolean> {
    await prisma.quickBooksPostingSlot.createMany({ data: [{ orgId, until: new Date(0) }], skipDuplicates: true });
    await recordExpired(orgId, new Date());
    const now = Date.now();
    const { count } = await prisma.quickBooksPostingSlot.updateMany({
        where: { orgId, until: { lt: new Date(now) } },
        data: { holder: lane, runId, until: new Date(now + SLOT_MS) },
    });
    return count === 1;
}

function turnOf(orgId: string, lane: PostingLane, runId: string): PostingTurn {
    return {
        yielded: false,
        async renew() {
            const { count } = await prisma.quickBooksPostingSlot.updateMany({ where: { orgId, runId }, data: { until: new Date(Date.now() + SLOT_MS) } });
            if (count === 0) logger.warn("[quickbooks] qb_slot_lost", { lane, runId });
            return count === 1;
        },
    };
}

/** Frees the slot if this run still holds it, recording how the lane's run ended and what it booked. */
async function release(orgId: string, lane: PostingLane, runId: string, end: { ended: Exclude<RunEnd, "expired">; counts: RunCounts } | null): Promise<void> {
    try {
        const slot = await prisma.quickBooksPostingSlot.findUnique({ where: { orgId }, select: { runId: true, lastRuns: true } });
        if (slot?.runId !== runId) return;
        const data: Prisma.QuickBooksPostingSlotUpdateManyMutationInput = { until: new Date(0), runId: null };
        if (end) {
            const lastRuns = readLastRuns(slot.lastRuns);
            const before = lastRuns[lane]?.yieldsInRow ?? 0;
            const yieldsInRow = end.ended === "yielded" ? before + 1 : end.ended === "done" ? 0 : before;
            const run: LastRun = { endedAt: new Date().toISOString(), ended: end.ended, ...end.counts, yieldsInRow };
            data.lastRuns = { ...lastRuns, [lane]: run };
        }
        await prisma.quickBooksPostingSlot.updateMany({ where: { orgId, runId }, data });
    } catch (err) {
        logger.error("[quickbooks] posting slot release failed; it expires on its own:", err);
    }
}

/** Queues `lane` once: a lane already waiting keeps its place. */
async function enqueue(orgId: string, lane: PostingLane, actor: number | null): Promise<void> {
    await prisma.quickBooksPostingQueue.upsert({
        where: { orgId_lane: { orgId, lane } },
        create: { orgId, lane, requestedById: actor },
        update: {},
    });
    logger.info("[quickbooks] qb_slot_queued", { lane });
}

/** Runs `lane` under a slot already taken, then releases it; a lane that yielded queues again behind the rest. */
async function runHeld<L extends PostingLane>(orgId: string, lane: L, runId: string): Promise<{ result: LaneResults[L]; ended: RunEnd }> {
    const turn = turnOf(orgId, lane, runId);
    let ended: "done" | "yielded" | "crashed" = "crashed";
    let counts = NO_COUNTS;
    try {
        const result = await LANE_RUNS[lane](turn);
        ended = turn.yielded ? "yielded" : "done";
        counts = LANE_COUNTS[lane](result);
        return { result, ended };
    } finally {
        await release(orgId, lane, runId, { ended, counts });
        if (ended === "yielded") await enqueue(orgId, lane, null).catch((err: unknown) => logger.error("[quickbooks] re-queue after a throttle failed:", err));
    }
}

/**
 * Starts the oldest queued lane whenever the slot is free, until the queue is empty or another run
 * holds the slot (that run starts the rest). A lane that yielded in this chain waits for the next
 * request or the daily run, so a busy QuickBooks never loops.
 */
async function runQueue(orgId: string, yielded: Set<PostingLane>): Promise<void> {
    for (;;) {
        const queue = await prisma.quickBooksPostingQueue.findMany({ where: { orgId }, orderBy: [{ requestedAt: "asc" }, { id: "asc" }] });
        const next = queue.find((q) => isPostingLane(q.lane) && !yielded.has(q.lane));
        if (!next || !isPostingLane(next.lane)) return;
        const runId = randomUUID();
        if (!(await takeSlot(orgId, next.lane, runId))) return;
        await prisma.quickBooksPostingQueue.deleteMany({ where: { id: next.id } });
        try {
            const { result, ended } = await runHeld(orgId, next.lane, runId);
            logger.info(`[quickbooks] queued ${next.lane} run ${JSON.stringify(result)}`);
            if (ended === "yielded") yielded.add(next.lane);
        } catch (err) {
            logger.error(`[quickbooks] queued ${next.lane} run failed:`, err);
        }
    }
}

function chain(orgId: string, yielded: Set<PostingLane>): void {
    runQueue(orgId, yielded).catch((err: unknown) => logger.error("[quickbooks] posting queue failed:", err));
}

/**
 * Asks for a run of one lane: takes the slot and starts it (`done` settles with the lane's counts),
 * or queues the lane behind the run holding the slot. A lane already running is left to finish.
 * The run that ends starts the oldest queued lane, so a stranded queue restarts with any request.
 * `actor` is the person who asked; null for the daily run.
 */
export async function requestPostingRun<L extends PostingLane>(lane: L, actor: number | null): Promise<PostingRun<LaneResults[L]>> {
    const orgId = (await getOrg()).id;
    const runId = randomUUID();
    if (!(await takeSlot(orgId, lane, runId))) {
        const slot = await slotState(orgId);
        if (slot.heldBy === lane) return { status: "running", slot };
        await enqueue(orgId, lane, actor);
        // The holder may have released between the take and the queue write, finding nothing queued.
        chain(orgId, new Set());
        return { status: "queued", slot: await slotState(orgId) };
    }
    try {
        // The asker's own queue row, if any, is this run.
        await prisma.quickBooksPostingQueue.deleteMany({ where: { orgId, lane } });
    } catch (err) {
        await release(orgId, lane, runId, null);
        throw err;
    }
    const own = runHeld(orgId, lane, runId);
    own.then(
        ({ ended }) => chain(orgId, new Set(ended === "yielded" ? [lane] : [])),
        () => chain(orgId, new Set()),
    );
    return { status: "started", done: own.then((r) => r.result) };
}

/** Starts any lanes still queued while the slot is free, to its end: the daily run's last step. */
export async function runPostingQueue(): Promise<void> {
    await runQueue((await getOrg()).id, new Set());
}

/** A lane's place relative to the slot, for finance's catch-up; with no lane, whether any run holds it. */
export async function postingCatchUpState(lane: PostingLane | null): Promise<PostingCatchUp> {
    const slot = await slotState((await getOrg()).id);
    const running = lane === null ? slot.heldBy !== null : slot.heldBy === lane;
    const status = running ? "running" : slot.heldBy === null && slot.queued.length > 0 ? "stranded" : lane !== null && slot.queued.includes(lane) ? "queued" : "idle";
    return { lane, status, ...slot };
}

/**
 * Finance's catch-up: audits who asked, then asks for a run of `lane`. A started run goes on after
 * the request answers; if the audit write fails, nothing is asked.
 */
export async function catchUpPosting(lane: PostingLane, actorId: number): Promise<PostingCatchUp> {
    await prisma.auditLog.create({
        data: { ...personActor(actorId), action: "CREATE", tableName: "QuickBooksPostingQueue", affectedEntityId: 0, newData: { lane, request: "catch-up" } },
    });
    const run = await requestPostingRun(lane, actorId);
    if (run.status === "started") {
        run.done.then(
            (result) => logger.info(`[quickbooks] catch-up ${lane} run ${JSON.stringify(result)}`),
            (err: unknown) => logger.error(`[quickbooks] catch-up ${lane} run failed:`, err),
        );
        return { lane, status: "started", ...(await slotState((await getOrg()).id)) };
    }
    return { lane, status: run.status, ...run.slot };
}
