import type { VisitSource } from "@/generated/prisma/client";

/**
 * Post-hoc significance of a self-correction (docs/rules/attendance-checkin.md):
 * the edit always applies; a change
 * is flagged to the board only when it is large relative to how authoritative
 * the value it overwrote was. significance = Σ per-field (minutes shifted ×
 * source trust-weight), over a threshold. Every delete flags (the floor):
 * erasing a record is inherently notable.
 *
 * Weights and threshold are v1 defaults awaiting board calibration (backlog
 * AT15: promote to BoardSettings).
 */

const WEIGHTS: Record<VisitSource, number> = {
    SCANNER: 3,     // physical measurement
    LEAD_MARKED: 2, // staff observation (roster mark) — residual when how is unknown
    TYPED: 1,       // a clock typed into a form (how). Who is byProxy, not this.
    WEB: 1,         // retired; only the previous release writes it, during a rolling deploy's drain window
    // A machine close is a placeholder the member is *meant* to fix, so
    // correcting one never flags — suppressed by SOURCE, not magnitude: the cron stamps at its own run time, making the correction largest
    // exactly where the overwritten value deserves the least trust.
    FACILITY_CLOSE: 0,
    AUTO_CLOSE: 0,
};
// Sits above a 15-min shift of both ends of a roster-marked visit (60) and
// below a 2h move of a scanned arrival (360) — the design's no/yes examples.
const FLAG_THRESHOLD = 90; // weighted minutes
// One adult changing another person's record is itself a flag input, so a household lead's edit of a member's visit weighs double: the same
// nudge that is noise on your own record is worth seeing on someone else's.
const PROXY_MULTIPLIER = 2;

type VisitTimes = {
    arrivedAt: Date;
    departedAt: Date | null;
    arrivedVia: VisitSource | null;
    departedVia: VisitSource | null;
};

export type Significance = { score: number; flagged: boolean };

function weightOf(source: VisitSource | null): number {
    if (!source) return WEIGHTS.WEB; // untagged legacy value ≈ self-reported
    return WEIGHTS[source];
}

function minutesBetween(a: Date | null, b: Date | null): number {
    // One side null only when CLOSING an open visit — the most routine
    // correction there is; no delta to weigh. Reopening never reaches here:
    // every write path refuses it, so a closed visit keeps its departure.
    if (!a || !b) return 0;
    return Math.abs(a.getTime() - b.getTime()) / 60000;
}

/** `byProxy`: the actor is not the visit's person (a household lead acting for
 * a member). `now`: clock for scoring an open visit's delete — tests inject a
 * fixed value; defaults to real time. */
export type SignificanceOpts = { byProxy?: boolean; now?: Date };

/** Significance of editing a visit's times, weighted by the OLD values' sources. */
export function editSignificance(
    oldVisit: VisitTimes,
    newTimes: { arrivedAt: Date; departedAt: Date | null },
    opts: SignificanceOpts = {},
): Significance {
    const score = (
        minutesBetween(oldVisit.arrivedAt, newTimes.arrivedAt) * weightOf(oldVisit.arrivedVia) +
        minutesBetween(oldVisit.departedAt, newTimes.departedAt) * weightOf(oldVisit.departedVia)
    ) * (opts.byProxy ? PROXY_MULTIPLIER : 1);
    return { score: Math.round(score), flagged: score >= FLAG_THRESHOLD };
}

/**
 * A delete always flags — the floor. Score reflects how much recorded time
 * vanished; a still-open visit has no recorded end, so it scores against time
 * on site so far — deleting the live roster is not "nothing happened yet".
 */
export function deleteSignificance(visit: VisitTimes, opts: SignificanceOpts = {}): Significance {
    const duration = minutesBetween(visit.arrivedAt, visit.departedAt ?? opts.now ?? new Date());
    const weight = Math.max(
        weightOf(visit.arrivedVia),
        weightOf(visit.departedVia),
    );
    return { score: Math.round(duration * weight * (opts.byProxy ? PROXY_MULTIPLIER : 1)), flagged: true };
}
