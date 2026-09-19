import { expiringApprovals, type ApprovalExpiry } from "@/lib/trusted-adult/filters";

// Pure, DB-free unit coverage for the "expiring per adult" collapse. The integration
// tests exercise it end to end; these pin the boundary and tie-break logic directly.
describe("expiringApprovals", () => {
    const now = new Date("2026-09-12T00:00:00.000Z");
    const day = 86400000;
    const at = (days: number) => new Date(now.getTime() + days * day);
    const warnThreshold = at(30);

    const run = (rows: ApprovalExpiry[]) => expiringApprovals(rows, now, warnThreshold);

    it("reports an adult whose only approval is inside the window", () => {
        expect(run([{ trustedAdultId: 1, reviewBy: at(10) }])).toHaveLength(1);
    });

    it("suppresses a stale in-window row when a later approval outlives it", () => {
        const out = run([
            { trustedAdultId: 1, reviewBy: at(10) }, // stale, in window
            { trustedAdultId: 1, reviewBy: at(300) }, // live renewal, far out
        ]);
        expect(out).toHaveLength(0);
    });

    it("keeps the latest approval when it too is inside the window", () => {
        const out = run([
            { trustedAdultId: 1, reviewBy: at(5) },
            { trustedAdultId: 1, reviewBy: at(20) },
        ]);
        expect(out.map((r) => r.reviewBy)).toEqual([at(20)]);
    });

    it("skips rows with a null reviewBy", () => {
        expect(run([{ trustedAdultId: 1, reviewBy: null }])).toHaveLength(0);
    });

    it("excludes the boundaries the sweep excludes: reviewBy == now (lapsed) is out, reviewBy == warnThreshold is in", () => {
        expect(run([{ trustedAdultId: 1, reviewBy: now }])).toHaveLength(0); // > now, not >=
        expect(run([{ trustedAdultId: 2, reviewBy: at(-1) }])).toHaveLength(0); // already lapsed
        expect(run([{ trustedAdultId: 3, reviewBy: warnThreshold }])).toHaveLength(1); // <= threshold
        expect(run([{ trustedAdultId: 4, reviewBy: at(31) }])).toHaveLength(0); // past threshold
    });

    it("collapses per adult independently", () => {
        const out = run([
            { trustedAdultId: 1, reviewBy: at(10) }, // expiring
            { trustedAdultId: 2, reviewBy: at(10) }, // stale
            { trustedAdultId: 2, reviewBy: at(300) }, // renewed
        ]);
        expect(out.map((r) => r.trustedAdultId)).toEqual([1]);
    });

    it("breaks a reviewBy tie by input order (first wins) so an id-asc caller is deterministic", () => {
        type Row = ApprovalExpiry & { id: number };
        const rows: Row[] = [
            { id: 7, trustedAdultId: 1, reviewBy: at(10) },
            { id: 9, trustedAdultId: 1, reviewBy: at(10) },
        ];
        const out = expiringApprovals(rows, now, warnThreshold);
        expect(out).toHaveLength(1);
        expect(out[0].id).toBe(7);
    });

    it("returns nothing for empty input", () => {
        expect(run([])).toHaveLength(0);
    });
});
