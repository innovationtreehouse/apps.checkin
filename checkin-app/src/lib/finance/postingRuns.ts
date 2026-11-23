import prisma from "@/lib/prisma";
import { getOrg } from "@/lib/components/host";

// Each QuickBooks posting lane's last run, as the posting slot stores it, and the warnings it raises.

export type PostingLane = "expense" | "in-kind" | "income";
export const POSTING_LANES: readonly PostingLane[] = ["expense", "in-kind", "income"];
const LANE_NAMES: readonly string[] = POSTING_LANES;
export const isPostingLane = (value: unknown): value is PostingLane => typeof value === "string" && LANE_NAMES.includes(value);

/** How a lane's last run ended: it finished, yielded to a second throttle, threw, or lost the slot without releasing it. */
export type RunEnd = "done" | "yielded" | "crashed" | "expired";

/** One lane's last run. `capped` names the cap that stopped it with entries still due. */
export type LastRun = {
    endedAt: string;
    ended: RunEnd;
    created: number;
    matched: number;
    capped: "count" | "day" | "cents" | null;
    /** Runs in a row this lane yielded to a throttle. */
    yieldsInRow: number;
};
export type LastRuns = Partial<Record<PostingLane, LastRun>>;

export type RunCounts = Pick<LastRun, "created" | "matched" | "capped">;
export const NO_COUNTS: RunCounts = { created: 0, matched: 0, capped: null };

const RUN_ENDS: readonly string[] = ["done", "yielded", "crashed", "expired"] satisfies RunEnd[];
const CAPS: readonly string[] = ["count", "day", "cents"] satisfies NonNullable<LastRun["capped"]>[];
const isRunEnd = (v: unknown): v is RunEnd => typeof v === "string" && RUN_ENDS.includes(v);
const isCap = (v: unknown): v is NonNullable<LastRun["capped"]> => typeof v === "string" && CAPS.includes(v);
const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** The slot's stored `lastRuns`, keeping only well-formed lanes; a field missing from an older entry reads as zero or none. */
export function readLastRuns(value: unknown): LastRuns {
    const out: LastRuns = {};
    if (!value || typeof value !== "object" || Array.isArray(value)) return out;
    for (const [lane, entry] of Object.entries(value)) {
        if (!isPostingLane(lane) || !entry || typeof entry !== "object") continue;
        const r: Record<string, unknown> = { ...entry };
        if (typeof r.endedAt !== "string" || !isRunEnd(r.ended)) continue;
        out[lane] = { endedAt: r.endedAt, ended: r.ended, created: count(r.created), matched: count(r.matched), capped: isCap(r.capped) ? r.capped : null, yieldsInRow: count(r.yieldsInRow) };
    }
    return out;
}

/** Runs in a row a lane may yield to throttling before it is a warning. */
export const THROTTLE_YIELDS_WARNING = 3;

const LANE_NAME: Record<PostingLane, string> = { expense: "expense", "in-kind": "gifts of goods", income: "income" };

export interface PostingWarning {
    lane: PostingLane;
    cause: "throttled" | "expired";
    text: string;
}

/**
 * The lanes whose last run needs a person: one that yielded to throttling THROTTLE_YIELDS_WARNING
 * runs in a row (QuickBooks degraded, or the monthly allowance used up), or one whose run lost the
 * slot without releasing it (a crash or a hang). Each clears on the lane's next clean end.
 */
export function postingWarnings(lastRuns: LastRuns): PostingWarning[] {
    return POSTING_LANES.flatMap((lane): PostingWarning[] => {
        const run = lastRuns[lane];
        if (!run) return [];
        const name = LANE_NAME[lane];
        if (run.ended === "expired") return [{ lane, cause: "expired", text: `The ${name} QuickBooks run held the posting slot until ${run.endedAt.slice(0, 16).replace("T", " ")} UTC without releasing it: it crashed or hung.` }];
        if (run.yieldsInRow >= THROTTLE_YIELDS_WARNING)
            return [{ lane, cause: "throttled", text: `QuickBooks throttled the ${name} run ${run.yieldsInRow} runs in a row: QuickBooks may be degraded, or the monthly allowance used up.` }];
        return [];
    });
}

/** The warnings in force, from the slot's stored last runs. */
export async function currentPostingWarnings(): Promise<PostingWarning[]> {
    const slot = await prisma.quickBooksPostingSlot.findUnique({ where: { orgId: (await getOrg()).id }, select: { lastRuns: true } });
    return postingWarnings(readLastRuns(slot?.lastRuns));
}
