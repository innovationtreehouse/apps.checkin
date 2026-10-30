/**
 * @jest-environment node
 */
import {
    financeViewKey,
    financeViewWindow,
    recordFinanceView,
    type FinanceView,
} from "@/lib/finance/financeViewLog";
import type { DbClient } from "@/lib/db-client";

const makeDb = () => ({ financeViewLog: { createMany: jest.fn().mockResolvedValue({ count: 1 }) } });
const asDb = (db: ReturnType<typeof makeDb>) => db as unknown as DbClient;

const view: FinanceView = {
    actorId: 42,
    role: "isFinance",
    endpoint: "GET /api/receipts/[id]",
    params: { id: "r_123" },
    recordIds: ["r_123"],
    rowCount: 1,
};

describe("financeViewWindow", () => {
    test.each([
        ["2026-10-27T14:00:00.000Z", "2026-10-27T14:00:00.000Z"],
        ["2026-10-27T14:14:59.999Z", "2026-10-27T14:00:00.000Z"],
        ["2026-10-27T14:15:00.000Z", "2026-10-27T14:15:00.000Z"],
        ["2026-10-27T23:59:30.000Z", "2026-10-27T23:45:00.000Z"],
    ])("%s falls in the window starting %s", (at, start) => {
        expect(financeViewWindow(new Date(at)).toISOString()).toBe(start);
    });
});

describe("financeViewKey", () => {
    test("is a 64-character hex SHA-256", () => {
        expect(financeViewKey(view)).toMatch(/^[0-9a-f]{64}$/);
    });

    test("ignores the order of param keys and record ids", () => {
        const a = { endpoint: "GET /x/[a]/[b]", params: { a: "1", b: "2" }, recordIds: ["3", "1", "2"] };
        const b = { endpoint: "GET /x/[a]/[b]", params: { b: "2", a: "1" }, recordIds: ["2", "3", "1"] };
        expect(financeViewKey(a)).toBe(financeViewKey(b));
    });

    test("does not reorder the caller's record ids", () => {
        const recordIds = ["b", "a"];
        financeViewKey({ ...view, recordIds });
        expect(recordIds).toEqual(["b", "a"]);
    });

    test.each([
        ["endpoint", { endpoint: "GET /api/receipts" }],
        ["a param value", { params: { id: "r_124" } }],
        ["a param name", { params: { receiptId: "r_123" } }],
        ["the record ids", { recordIds: ["r_123", "r_124"] }],
    ])("changes with %s", (_label, change) => {
        expect(financeViewKey({ ...view, ...change })).not.toBe(financeViewKey(view));
    });

    test("does not run the endpoint into the params or ids", () => {
        const a = { endpoint: "GET /a", params: {}, recordIds: ["b"] };
        const b = { endpoint: "GET /ab", params: {}, recordIds: [] };
        expect(financeViewKey(a)).not.toBe(financeViewKey(b));
    });
});

describe("recordFinanceView", () => {
    test("writes one row with the window and key, skipping duplicates", async () => {
        const db = makeDb();
        const viewedAt = new Date("2026-10-27T14:07:12.345Z");
        await recordFinanceView({ ...view, viewedAt }, asDb(db));

        expect(db.financeViewLog.createMany).toHaveBeenCalledTimes(1);
        expect(db.financeViewLog.createMany).toHaveBeenCalledWith({
            data: [{
                viewedAt,
                actorId: 42,
                role: "isFinance",
                endpoint: "GET /api/receipts/[id]",
                params: { id: "r_123" },
                recordIds: ["r_123"],
                rowCount: 1,
                window: new Date("2026-10-27T14:00:00.000Z"),
                viewKey: financeViewKey(view),
            }],
            skipDuplicates: true,
        });
    });

    test("stamps the current time when no viewedAt is given", async () => {
        jest.useFakeTimers().setSystemTime(new Date("2026-10-27T09:31:00.000Z"));
        try {
            const db = makeDb();
            await recordFinanceView(view, asDb(db));
            const [row] = db.financeViewLog.createMany.mock.calls[0][0].data;
            expect(row.viewedAt.toISOString()).toBe("2026-10-27T09:31:00.000Z");
            expect(row.window.toISOString()).toBe("2026-10-27T09:30:00.000Z");
        } finally {
            jest.useRealTimers();
        }
    });

    test("rethrows a database failure", async () => {
        const db = makeDb();
        db.financeViewLog.createMany.mockRejectedValue(new Error("connection lost"));
        await expect(recordFinanceView(view, asDb(db))).rejects.toThrow("connection lost");
    });
});
