/**
 * @jest-environment node
 */
import { parseCutoff, toFinanceView, type DonorReadRow } from "../copy-donor-reads";

const occurredAt = new Date("2026-10-01T12:34:56.789Z");
const row = (over: Partial<DonorReadRow>): DonorReadRow => ({
    id: 1,
    entityId: null,
    actorUserId: 7,
    payload: JSON.stringify({ route: "GET /api/donations/transactions" }),
    occurredAt,
    ...over,
});

describe("toFinanceView", () => {
    it("copies a per-record read with its entity id as the one record", () => {
        const view = toFinanceView(row({ entityId: "r_abc", payload: JSON.stringify({ route: "GET /api/receipts/r_abc" }) }));
        expect(view).toEqual({
            actorId: 7,
            role: null,
            endpoint: "GET /api/receipts/r_abc",
            params: {},
            recordIds: ["r_abc"],
            rowCount: 1,
            viewedAt: occurredAt,
        });
    });

    it("takes the record ids and count from the payload when no entity id is set", () => {
        const view = toFinanceView(row({ payload: JSON.stringify({ route: "GET /api/donations/transactions/[id]", ids: [12], count: 1 }) }));
        expect(view).toMatchObject({ endpoint: "GET /api/donations/transactions/[id]", recordIds: ["12"], rowCount: 1 });
    });

    it("keeps a list read's count with no record ids", () => {
        const payload = JSON.stringify({ route: "GET /api/donations/transactions", filter: { assigned: null }, count: 3 });
        expect(toFinanceView(row({ payload }))).toMatchObject({ recordIds: [], rowCount: 3, params: {} });
    });

    it("prefers the payload count over the number of ids", () => {
        const payload = JSON.stringify({ route: "GET /api/donations/comment-rules", count: 0 });
        expect(toFinanceView(row({ payload }))).toMatchObject({ recordIds: [], rowCount: 0 });
    });

    it("counts the record ids when the payload has no count", () => {
        const payload = JSON.stringify({ route: "GET /x", ids: [1, 2] });
        expect(toFinanceView(row({ payload }))).toMatchObject({ recordIds: ["1", "2"], rowCount: 2 });
    });

    it("keeps the route exactly as stored", () => {
        const payload = JSON.stringify({ route: "/api/donations/transactions" });
        expect(toFinanceView(row({ payload }))?.endpoint).toBe("/api/donations/transactions");
    });

    it("skips a row with no actor", () => {
        expect(toFinanceView(row({ actorUserId: null }))).toBeNull();
    });

    it.each([null, "not json", JSON.stringify({ count: 1 })])("refuses an unreadable payload %p", (payload) => {
        expect(() => toFinanceView(row({ id: 99, payload }))).toThrow("Donor-read row 99 has an unreadable payload");
    });
});

describe("parseCutoff", () => {
    it("reads an ISO time with a zone", () => {
        expect(parseCutoff(["--cutoff", "2026-10-28T17:04:00Z"]).toISOString()).toBe("2026-10-28T17:04:00.000Z");
        expect(parseCutoff(["--commit", "--cutoff", "2026-10-28T10:04:00-07:00"]).toISOString()).toBe("2026-10-28T17:04:00.000Z");
    });

    it("requires the cutoff", () => {
        expect(() => parseCutoff([])).toThrow("--cutoff <ISO time> is required");
        expect(() => parseCutoff(["--cutoff"])).toThrow("--cutoff <ISO time> is required");
    });

    it("refuses a time without a zone or not a time", () => {
        expect(() => parseCutoff(["--cutoff", "2026-10-28T17:04:00"])).toThrow("must name its time zone");
        expect(() => parseCutoff(["--cutoff", "yesterdayZ"])).toThrow("not a valid time");
    });
});
