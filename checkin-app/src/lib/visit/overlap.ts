import type { TxClient } from "@/lib/db-client";
import { intervalsOverlap, type Interval } from "@/lib/attendanceConflicts";
import { resolveDisplayTimezone } from "@/lib/appSettings";
import { formatDateTime } from "@/lib/time";
import type { Significance } from "@/lib/visit/significance";

export type VisitOverlaps = {
    /** When the person's open visit began, if these times overlap it. */
    openSince: Date | null;
    /** The person's closed visits these times overlap. */
    closedIds: number[];
};

/**
 * What a reconciliation write's closed times overlap among the person's other
 * live visits: an open one refuses the write, a closed one flags it. Call under
 * the person lock.
 */
export async function findVisitOverlaps(
    tx: TxClient,
    personId: number,
    times: Interval,
    excludeVisitId?: number,
): Promise<VisitOverlaps> {
    const visits = await tx.visit.findMany({
        where: { personId, deletedAt: null, ...(excludeVisitId ? { id: { not: excludeVisitId } } : {}) },
        select: { id: true, arrivedAt: true, departedAt: true },
    });
    const hits = visits.filter(v => intervalsOverlap(times, v));
    return {
        openSince: hits.find(v => v.departedAt === null)?.arrivedAt ?? null,
        closedIds: hits.filter(v => v.departedAt !== null).map(v => v.id),
    };
}

/** The refusal for times that overlap an open visit. Reads settings, so call it after the transaction. */
export async function openOverlapRefusal(openSince: Date): Promise<string> {
    const timeZone = await resolveDisplayTimezone();
    return `This person is checked in from ${formatDateTime(openSince, { timeZone })}. They badge out at the kiosk first, or wait for tonight's close.`;
}

/** The audit fields that flag an overlap for the corrections review; a write with none keeps its own score. */
export function overlapFlag(closedIds: number[], significance?: Significance) {
    if (closedIds.length === 0) return significance ? { significance } : {};
    return { significance: { score: significance?.score ?? 0, flagged: true }, overlapsVisitIds: closedIds };
}
