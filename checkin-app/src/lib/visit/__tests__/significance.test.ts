import { editSignificance, deleteSignificance } from "../significance";

const at = (h: number, m = 0) => new Date(Date.UTC(2026, 6, 1, h, m));

// The cases the design doc's significance rules call out
// (1256_ATTENDANCE_CORRECTION_SURFACE.md §2).
describe("editSignificance", () => {
    it("+5 min on own WEB arrival — noise, not flagged", () => {
        const r = editSignificance(
            { arrivedAt: at(14), departedAt: at(16), arrivedVia: "WEB", departedVia: "WEB" },
            { arrivedAt: at(14, 5), departedAt: at(16) },
        );
        expect(r.flagged).toBe(false);
    });

    it("TYPED weighs the same as WEB — how is typed, who is byProxy", () => {
        const web = editSignificance(
            { arrivedAt: at(14), departedAt: at(16), arrivedVia: "WEB", departedVia: "WEB" },
            { arrivedAt: at(16), departedAt: at(18) },
        );
        const typed = editSignificance(
            { arrivedAt: at(14), departedAt: at(16), arrivedVia: "TYPED", departedVia: "TYPED" },
            { arrivedAt: at(16), departedAt: at(18) },
        );
        expect(typed.score).toBe(web.score);
        expect(typed.score).toBe(240); // 120 min × 1 × two ends
    });

    // The nightly sweep stamps departedAt at CRON-RUN time, so the routine
    // "forgot to check out" fix is a 10h+ correction. Suppression is by source,
    // so no magnitude can push it over the threshold.
    it("fixing a machine-closed departure never flags, however large the correction", () => {
        const arrivedAt = new Date(Date.UTC(2026, 6, 1, 9));   // arrive 9am
        const r = editSignificance(
            { arrivedAt, departedAt: new Date(Date.UTC(2026, 6, 2, 2)), arrivedVia: "SCANNER", departedVia: "AUTO_CLOSE" },
            { arrivedAt, departedAt: new Date(Date.UTC(2026, 6, 1, 13)) }, // really left 1pm
        );
        expect(r.score).toBe(0); // 780 min × 0
        expect(r.flagged).toBe(false);
    });

    it("a FACILITY_CLOSE fix is free too — a placeholder is a placeholder", () => {
        const r = editSignificance(
            { arrivedAt: at(14), departedAt: at(20), arrivedVia: "SCANNER", departedVia: "FACILITY_CLOSE" },
            { arrivedAt: at(14), departedAt: at(18) },
        );
        expect(r.flagged).toBe(false);
    });

    it("15-min shift of a LEAD_MARKED visit — small delta, not flagged", () => {
        const r = editSignificance(
            { arrivedAt: at(14), departedAt: at(16), arrivedVia: "LEAD_MARKED", departedVia: "LEAD_MARKED" },
            { arrivedAt: at(14, 15), departedAt: at(16, 15) },
        );
        expect(r.flagged).toBe(false); // (15+15) × 2 = 60 < 90
    });

    // The whole point of splitting SYSTEM: LEAD_MARKED on a departure is a staff
    // assertion worth weighing, the two machine closers are placeholders worth
    // nothing. Pre-split they were one value and had to be told apart by
    // inference from the arrival side.
    it("distinguishes a LEAD_MARKED departure from the two machine closes by source alone", () => {
        const shift = { arrivedAt: at(14), departedAt: at(17) };
        const base = { arrivedAt: at(14), departedAt: at(16), arrivedVia: "SCANNER" as const };
        expect(editSignificance({ ...base, departedVia: "LEAD_MARKED" }, shift).score).toBe(120); // 60 × 2
        expect(editSignificance({ ...base, departedVia: "FACILITY_CLOSE" }, shift).score).toBe(0);
        expect(editSignificance({ ...base, departedVia: "AUTO_CLOSE" }, shift).score).toBe(0);
    });

    it("moving a SCANNER arrival 2h — overwrites a measurement, flagged", () => {
        const r = editSignificance(
            { arrivedAt: at(14), departedAt: at(16), arrivedVia: "SCANNER", departedVia: "SCANNER" },
            { arrivedAt: at(12), departedAt: at(16) },
        );
        expect(r.flagged).toBe(true); // 120 × 3 = 360
    });

    // Legacy SYSTEM rows survive in two places: history the backfill mapped, and
    // anything the previous release writes during a rolling deploy's drain
    // window. Until the contract release drops the value, the old inference has
    // to keep working — a SYSTEM pair is a roster mark, a SYSTEM departure on a
    // real arrival is a machine close.
    it("still reads legacy SYSTEM by inference: a SYSTEM pair is a roster mark, not an auto-close", () => {
        const rosterPair = editSignificance(
            { arrivedAt: at(14), departedAt: at(16), arrivedVia: "SYSTEM", departedVia: "SYSTEM" },
            { arrivedAt: at(14), departedAt: at(17) },
        );
        expect(rosterPair.score).toBe(120); // 60 min × 2, not × 0

        const machineClose = editSignificance(
            { arrivedAt: at(14), departedAt: at(16), arrivedVia: "SCANNER", departedVia: "SYSTEM" },
            { arrivedAt: at(14), departedAt: at(17) },
        );
        expect(machineClose.score).toBe(0);
    });

    // The repeat-correction bug (docs/rules/attendance-checkin.md, visit-record:
    // "Correcting the same time twice is weighed the second time as overwriting a
    // self-report"). The route restamps arrivedVia to TYPED after the first
    // correction, so the SECOND correction is weighed against TYPED, not the
    // original SCANNER. Modelled here as the two pre-edit states the route feeds.
    it("weighs a repeat arrival correction as a self-report, not the original measurement", () => {
        // First correction: still overwriting the badge measurement (SCANNER=3).
        const first = editSignificance(
            { arrivedAt: at(14), departedAt: at(16), arrivedVia: "SCANNER", departedVia: "TYPED" },
            { arrivedAt: at(14, 30), departedAt: at(16) },
        );
        expect(first).toEqual({ score: 90, flagged: true }); // 30 × 3

        // After the restamp the row is TYPED; the next correction is a self-report.
        const second = editSignificance(
            { arrivedAt: at(14, 30), departedAt: at(16), arrivedVia: "TYPED", departedVia: "TYPED" },
            { arrivedAt: at(15), departedAt: at(16) },
        );
        expect(second).toEqual({ score: 30, flagged: false }); // 30 × 1

        // Proof of the bug: without the restamp the second correction would still
        // weigh SCANNER and over-flag to the board.
        const withoutRestamp = editSignificance(
            { arrivedAt: at(14, 30), departedAt: at(16), arrivedVia: "SCANNER", departedVia: "TYPED" },
            { arrivedAt: at(15), departedAt: at(16) },
        );
        expect(withoutRestamp).toEqual({ score: 90, flagged: true });
    });

    it("closing an own open visit — the routine correction — does not flag", () => {
        const r = editSignificance(
            { arrivedAt: at(14), departedAt: null, arrivedVia: "WEB", departedVia: null },
            { arrivedAt: at(14), departedAt: at(16) },
        );
        expect(r.flagged).toBe(false);
    });
});

describe("deleteSignificance", () => {
    it("always flags, whatever the source — the delete floor", () => {
        expect(deleteSignificance(
            { arrivedAt: at(14), departedAt: at(14, 30), arrivedVia: "WEB", departedVia: "WEB" },
        ).flagged).toBe(true);
        expect(deleteSignificance(
            { arrivedAt: at(14), departedAt: null, arrivedVia: "WEB", departedVia: null },
            { now: at(15) },
        ).flagged).toBe(true);
    });

    it("scores by erased duration times the strongest source weight", () => {
        const r = deleteSignificance(
            { arrivedAt: at(14), departedAt: at(16), arrivedVia: "SCANNER", departedVia: "SCANNER" },
        );
        expect(r.score).toBe(360);
    });

    // #1630: an open visit has no recorded duration to weigh, so it must not
    // fall back to 0 — that made deleting the live roster the *lowest*-scoring
    // delete. Score against time on site so far instead.
    it("an open visit's delete scores elapsed time, not the floor", () => {
        const r = deleteSignificance(
            { arrivedAt: at(14), departedAt: null, arrivedVia: "SCANNER", departedVia: null },
            { now: at(20) },
        );
        expect(r).toEqual({ score: 1080, flagged: true }); // 360 min × 3 (SCANNER)
    });

    it("a closed visit's delete score is unaffected by `now` — duration is already fixed", () => {
        const r = deleteSignificance(
            { arrivedAt: at(14), departedAt: at(16), arrivedVia: "SCANNER", departedVia: "SCANNER" },
            { now: at(23) },
        );
        expect(r.score).toBe(360);
    });
});

// An adult changing another person's record is itself a flag input (design §3),
// so a household lead's correction weighs double.
describe("acting for a household member (byProxy)", () => {
    it("doubles an edit — the same shift that is noise on your own record flags here", () => {
        const own = { arrivedAt: at(14), departedAt: at(16), arrivedVia: "WEB" as const, departedVia: "WEB" as const };
        const moved = { arrivedAt: at(14, 50), departedAt: at(16) };
        expect(editSignificance(own, moved).flagged).toBe(false);          // 50
        expect(editSignificance(own, moved, { byProxy: true })).toEqual({ score: 100, flagged: true });
    });

    it("doubles a delete's score (which already flags either way)", () => {
        const visit = { arrivedAt: at(14), departedAt: at(16), arrivedVia: "WEB" as const, departedVia: "WEB" as const };
        expect(deleteSignificance(visit).score).toBe(120);
        expect(deleteSignificance(visit, { byProxy: true }).score).toBe(240);
    });

    // Source suppression outranks the proxy weight: fixing a cron-stamped
    // departure is the happy path whoever does it.
    it("never resurrects a machine-close correction", () => {
        const r = editSignificance(
            { arrivedAt: at(9), departedAt: at(23), arrivedVia: "SCANNER", departedVia: "SYSTEM" },
            { arrivedAt: at(9), departedAt: at(13) },
            { byProxy: true },
        );
        expect(r).toEqual({ score: 0, flagged: false });
    });
});
