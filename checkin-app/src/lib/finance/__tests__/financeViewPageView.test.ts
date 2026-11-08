/**
 * @jest-environment node
 */
import {
    OPEN_VIEW_KEY_PREFIX,
    absorbedIds,
    PAGE_VIEW_MERGE_MS,
    pageViewDisposition,
    pageViewKey,
    parseCalls,
    parseRecords,
    recordFinanceViewCall,
    unionCalls,
    unionRecords,
    untaggedViewKey,
    type FinanceViewCall,
} from "@/lib/finance/financeViewLog";
import type { DbClient } from "@/lib/db-client";

type Row = Record<string, unknown> & { id: number };
type Where = Record<string, unknown>;
type OrderBy = Record<string, "asc" | "desc">[];

function isObject(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date);
}

function matches(row: Row, where: Where): boolean {
    return Object.entries(where).every(([key, cond]) => {
        const value = row[key] ?? null;
        if (isObject(cond)) {
            if ("startsWith" in cond) return typeof value === "string" && value.startsWith(String(cond.startsWith));
            if ("lt" in cond) return value instanceof Date && cond.lt instanceof Date && value < cond.lt;
            if ("gte" in cond) return value instanceof Date && cond.gte instanceof Date && value >= cond.gte;
            if ("has" in cond) return Array.isArray(value) && value.includes(cond.has);
            throw new Error(`fake db: unsupported condition on ${key}`);
        }
        if (cond instanceof Date) return value instanceof Date && value.getTime() === cond.getTime();
        return value === cond;
    });
}

function sortRows(rows: Row[], orderBy: OrderBy = []): Row[] {
    const keyOf = (v: unknown) => (v instanceof Date ? v.getTime() : Number(v));
    return [...rows].sort((a, b) => {
        for (const clause of orderBy) {
            const [field, dir] = Object.entries(clause)[0];
            const diff = keyOf(a[field]) - keyOf(b[field]);
            if (diff !== 0) return dir === "asc" ? diff : -diff;
        }
        return 0;
    });
}

/** An in-memory FinanceViewLog enforcing the unique (actorId, viewKey, window) index. */
function makeDb() {
    const rows: Row[] = [];
    let nextId = 1;
    const uniqueKey = (r: Record<string, unknown>) =>
        `${String(r.actorId)}|${String(r.viewKey)}|${r.window instanceof Date ? r.window.getTime() : ""}`;
    const clashes = (candidate: Record<string, unknown>, selfId?: number) =>
        rows.some((r) => r.id !== selfId && uniqueKey(r) === uniqueKey(candidate));

    const financeViewLog = {
        findMany: jest.fn(async ({ where, orderBy }: { where: Where; orderBy?: OrderBy }) =>
            sortRows(rows.filter((r) => matches(r, where)), orderBy).map((r) => ({ ...r }))),
        findFirst: jest.fn(async ({ where, orderBy }: { where: Where; orderBy?: OrderBy }) => {
            const [hit] = sortRows(rows.filter((r) => matches(r, where)), orderBy);
            return hit ? { ...hit } : null;
        }),
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
            if (clashes(data)) throw new Error("unique violation");
            const row = { mergedPageViewIds: [], ...data, id: nextId++ };
            rows.push(row);
            return row;
        }),
        createMany: jest.fn(async ({ data }: { data: Record<string, unknown>[] }) => {
            let count = 0;
            for (const d of data) {
                if (clashes(d)) continue;
                rows.push({ mergedPageViewIds: [], ...d, id: nextId++ });
                count++;
            }
            return { count };
        }),
        update: jest.fn(async ({ where, data }: { where: { id: number }; data: Record<string, unknown> }) => {
            const row = rows.find((r) => r.id === where.id);
            if (!row) throw new Error("no row");
            if (clashes({ ...row, ...data }, row.id)) throw new Error("unique violation");
            Object.assign(row, data);
            return row;
        }),
        delete: jest.fn(async ({ where }: { where: { id: number } }) => {
            const i = rows.findIndex((r) => r.id === where.id);
            return rows.splice(i, 1)[0];
        }),
    };
    const db = {
        financeViewLog,
        $executeRaw: jest.fn(async () => 0),
        $transaction: jest.fn(),
    };
    db.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(db));
    return { db, rows, client: db as unknown as DbClient };
}

const T0 = new Date("2026-11-06T14:05:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
const PAGE = "/expense/expenses/e_123";

const expenseCall = (over: Partial<FinanceViewCall> = {}): FinanceViewCall => ({
    actorId: 42,
    role: "isFinance",
    endpoint: "GET /api/expense/expenses/[id]",
    path: "/api/expense/expenses/e_123",
    query: {},
    records: [{ ref: "Expense:e_123", fields: ["submitterId", "receiptTotalCents"] }],
    pageView: { id: "pv-1", path: PAGE },
    viewedAt: T0,
    ...over,
});

const panelCall = (over: Partial<FinanceViewCall> = {}): FinanceViewCall =>
    expenseCall({
        role: "isBucketApprover",
        endpoint: "GET /api/expense/expenses/[id]/reimbursee-vendor",
        path: "/api/expense/expenses/e_123/reimbursee-vendor",
        records: [{ ref: "Expense:e_123", fields: ["reimburseePersonId"] }],
        viewedAt: at(2000),
        ...over,
    });

describe("unionRecords", () => {
    test("merges by ref, unions and sorts the field names", () => {
        expect(unionRecords(
            [{ ref: "Expense:e_1", fields: ["b", "a"] }, { ref: "Receipt:r_9", fields: ["x"] }],
            [{ ref: "Expense:e_1", fields: ["c", "a"] }],
        )).toEqual([
            { ref: "Expense:e_1", fields: ["a", "b", "c"] },
            { ref: "Receipt:r_9", fields: ["x"] },
        ]);
    });

    test("never drops a record or a field", () => {
        const before = [{ ref: "Expense:e_1", fields: ["a", "b"] }];
        expect(unionRecords(before, [], [{ ref: "Expense:e_1", fields: [] }])).toEqual(before);
    });
});

describe("unionCalls", () => {
    const call = { endpoint: "GET /api/x", path: "/api/x", query: { tab: "holds", a: "1" }, role: "isFinance" };

    test("lists an identical call once, whatever its query order", () => {
        expect(unionCalls([call], [{ ...call, query: { a: "1", tab: "holds" } }])).toHaveLength(1);
    });

    test.each([
        ["query", { query: { tab: "queue", a: "1" } }],
        ["role", { role: "isBoard" }],
        ["path", { path: "/api/x?" }],
    ])("keeps a call that differs in %s", (_label, change) => {
        expect(unionCalls([call], [{ ...call, ...change }])).toHaveLength(2);
    });
});

describe("view keys", () => {
    const records = [{ ref: "Expense:e_1", fields: ["receiptTotalCents"] }];

    test("a page-view key ignores record and field order", () => {
        expect(pageViewKey(PAGE, [{ ref: "A:1", fields: ["b", "a"] }, { ref: "B:1", fields: [] }]))
            .toBe(pageViewKey(PAGE, [{ ref: "B:1", fields: [] }, { ref: "A:1", fields: ["a", "b"] }]));
    });

    test("a page-view key changes with the field names sent", () => {
        expect(pageViewKey(PAGE, records))
            .not.toBe(pageViewKey(PAGE, [{ ref: "Expense:e_1", fields: ["receiptTotalCents", "submitterId"] }]));
    });

    test("a page-view key changes with the page", () => {
        expect(pageViewKey(PAGE, records)).not.toBe(pageViewKey("/finance/review", records));
    });

    test("an untagged key changes with the field names sent", () => {
        const calls = [{ endpoint: "GET /api/x", path: "/api/x", query: {}, role: "isFinance" }];
        expect(untaggedViewKey(calls, records))
            .not.toBe(untaggedViewKey(calls, [{ ref: "Expense:e_1", fields: ["submitterId"] }]));
    });
});

describe("absorbedIds", () => {
    test("adds the absorbed row's id and its own absorbed ids, never the survivor's own id", () => {
        expect(absorbedIds(
            { pageViewId: "pv-1", mergedPageViewIds: ["pv-0"] },
            { pageViewId: "pv-3", mergedPageViewIds: ["pv-2", "pv-1"] },
        )).toEqual(["pv-0", "pv-2", "pv-3"]);
    });

    test("an absorbed row with the survivor's id adds nothing", () => {
        expect(absorbedIds({ pageViewId: "pv-1", mergedPageViewIds: [] }, { pageViewId: "pv-1", mergedPageViewIds: [] }))
            .toEqual([]);
    });
});

describe("pageViewDisposition", () => {
    const call = { actorId: 42, pageView: { id: "pv-1", path: PAGE } };

    test("the id's first use starts a row", () => {
        expect(pageViewDisposition(call, null, false)).toBe("new");
    });

    test("the same person and path merge into an open row", () => {
        expect(pageViewDisposition(call, { actorId: 42, pagePath: PAGE }, true)).toBe("merge");
    });

    test("the same person and path after the open row closed start a new row", () => {
        expect(pageViewDisposition(call, { actorId: 42, pagePath: PAGE }, false)).toBe("new");
    });

    test("another person's id is untagged", () => {
        expect(pageViewDisposition(call, { actorId: 7, pagePath: PAGE }, false)).toBe("untagged");
    });

    test("another path under the id is untagged", () => {
        expect(pageViewDisposition(call, { actorId: 42, pagePath: "/finance/review" }, true)).toBe("untagged");
    });
});

describe("recordFinanceViewCall", () => {
    test("an untagged call writes its own row, with calls and records and no page", async () => {
        const { rows, client, db } = makeDb();
        await recordFinanceViewCall(expenseCall({ pageView: null }), client);

        expect(rows).toHaveLength(1);
        const [row] = rows;
        expect(row).toMatchObject({
            viewedAt: T0,
            actorId: 42,
            role: "isFinance",
            calls: [{ endpoint: "GET /api/expense/expenses/[id]", path: "/api/expense/expenses/e_123", query: {}, role: "isFinance" }],
            records: [{ ref: "Expense:e_123", fields: ["receiptTotalCents", "submitterId"] }],
            recordIds: ["Expense:e_123"],
            recordCount: 1,
            window: new Date("2026-11-06T14:00:00.000Z"),
        });
        expect(row.pagePath).toBeUndefined();
        expect(row.pageViewId).toBeUndefined();
        expect(row.endpoint).toBeUndefined();
        expect(row.params).toBeUndefined();
        expect(row.rowCount).toBeUndefined();
        expect(row.viewKey).toMatch(/^[0-9a-f]{64}$/);
        expect(db.$executeRaw).toHaveBeenCalledTimes(1);
    });

    test("an untagged repeat collapses in its window, but not once it shows another field", async () => {
        const { rows, client } = makeDb();
        await recordFinanceViewCall(expenseCall({ pageView: null }), client);
        await recordFinanceViewCall(expenseCall({ pageView: null, viewedAt: at(60_000) }), client);
        expect(rows).toHaveLength(1);

        await recordFinanceViewCall(expenseCall({
            pageView: null,
            viewedAt: at(120_000),
            records: [{ ref: "Expense:e_123", fields: ["receiptTotalCents"] }],
        }), client);
        expect(rows).toHaveLength(2);
    });

    test("a page's calls merge into one row: records and fields unioned, first call's role and time", async () => {
        const { rows, client } = makeDb();
        await recordFinanceViewCall(expenseCall(), client);
        await recordFinanceViewCall(panelCall(), client);
        await recordFinanceViewCall(panelCall({
            endpoint: "GET /api/expense/expenses/[id]/qb-candidates",
            path: "/api/expense/expenses/e_123/qb-candidates",
            records: [{ ref: "QuickBooks.Transaction:4412", fields: ["amountCents"] }],
            viewedAt: at(PAGE_VIEW_MERGE_MS),
        }), client);

        expect(rows).toHaveLength(1);
        const [row] = rows;
        expect(row).toMatchObject({
            viewedAt: T0,
            role: "isFinance",
            pagePath: PAGE,
            pageViewId: "pv-1",
            recordIds: ["Expense:e_123", "QuickBooks.Transaction:4412"],
            recordCount: 2,
            records: [
                { ref: "Expense:e_123", fields: ["receiptTotalCents", "reimburseePersonId", "submitterId"] },
                { ref: "QuickBooks.Transaction:4412", fields: ["amountCents"] },
            ],
        });
        expect(parseCalls(row.calls).map((c) => [c.endpoint, c.role])).toEqual([
            ["GET /api/expense/expenses/[id]", "isFinance"],
            ["GET /api/expense/expenses/[id]/reimbursee-vendor", "isBucketApprover"],
            ["GET /api/expense/expenses/[id]/qb-candidates", "isBucketApprover"],
        ]);
        expect(String(row.viewKey).startsWith(OPEN_VIEW_KEY_PREFIX)).toBe(true);
    });

    test("merging never drops: an empty call adds nothing and removes nothing, a repeat call is listed once", async () => {
        const { rows, client } = makeDb();
        await recordFinanceViewCall(expenseCall(), client);
        await recordFinanceViewCall(panelCall({ records: [] }), client);
        await recordFinanceViewCall(expenseCall({ viewedAt: at(5000), records: [{ ref: "Expense:e_123", fields: [] }] }), client);

        expect(rows).toHaveLength(1);
        expect(parseRecords(rows[0].records)).toEqual([
            { ref: "Expense:e_123", fields: ["receiptTotalCents", "submitterId"] },
        ]);
        expect(parseCalls(rows[0].calls)).toHaveLength(2);
    });

    test("bound to the person: another person's call with the id writes an untagged row", async () => {
        const { rows, client } = makeDb();
        await recordFinanceViewCall(expenseCall(), client);
        await recordFinanceViewCall(panelCall({ actorId: 7 }), client);

        expect(rows).toHaveLength(2);
        const [mine, theirs] = rows;
        expect(parseRecords(mine.records)[0].fields).not.toContain("reimburseePersonId");
        expect(theirs).toMatchObject({ actorId: 7, recordIds: ["Expense:e_123"] });
        expect(theirs.pageViewId).toBeUndefined();
        expect(theirs.pagePath).toBeUndefined();
    });

    test("bound to the person even after the window: the other person never starts a row on the id", async () => {
        const { rows, client } = makeDb();
        await recordFinanceViewCall(expenseCall(), client);
        await recordFinanceViewCall(expenseCall({ actorId: 7, viewedAt: at(10 * 60_000) }), client);
        expect(rows.filter((r) => r.pageViewId === "pv-1").map((r) => r.actorId)).toEqual([42]);
    });

    test("one path per id: a call claiming another path writes an untagged row", async () => {
        const { rows, client } = makeDb();
        await recordFinanceViewCall(expenseCall(), client);
        await recordFinanceViewCall(panelCall({ pageView: { id: "pv-1", path: "/expense/expenses/e_999" } }), client);

        expect(rows).toHaveLength(2);
        expect(rows[1].pageViewId).toBeUndefined();
        expect(rows[1].calls).toEqual([expect.objectContaining({ endpoint: "GET /api/expense/expenses/[id]/reimbursee-vendor" })]);
    });

    test("the window: a late call by the same person on the same path starts a new page-view row on the id", async () => {
        const { rows, client } = makeDb();
        await recordFinanceViewCall(expenseCall(), client);
        await recordFinanceViewCall(panelCall({ viewedAt: at(PAGE_VIEW_MERGE_MS + 1) }), client);

        expect(rows).toHaveLength(2);
        expect(rows.map((r) => [r.pageViewId, r.pagePath])).toEqual([["pv-1", PAGE], ["pv-1", PAGE]]);
        expect(rows[0].viewKey).toBe(pageViewKey(PAGE, parseRecords(rows[0].records)));
        expect(String(rows[1].viewKey).startsWith(OPEN_VIEW_KEY_PREFIX)).toBe(true);
        expect(rows[1].viewedAt).toEqual(at(PAGE_VIEW_MERGE_MS + 1));
    });

    test("later calls past the window keep merging into the newest page-view row on the id", async () => {
        const { rows, client } = makeDb();
        await recordFinanceViewCall(expenseCall(), client);
        await recordFinanceViewCall(panelCall({ viewedAt: at(PAGE_VIEW_MERGE_MS + 1) }), client);
        await recordFinanceViewCall(expenseCall({
            records: [{ ref: "Expense:e_124", fields: ["receiptTotalCents"] }],
            viewedAt: at(PAGE_VIEW_MERGE_MS + 5000),
        }), client);

        expect(rows).toHaveLength(2);
        expect(rows[1].recordIds).toEqual(["Expense:e_123", "Expense:e_124"]);
    });

    test("a reload is a new row while open, and collapses into the earlier one once both are finished", async () => {
        const { rows, client } = makeDb();
        await recordFinanceViewCall(expenseCall(), client);
        await recordFinanceViewCall(expenseCall({ pageView: { id: "pv-2", path: PAGE }, viewedAt: at(1000), query: { from: "list" } }), client);
        expect(rows).toHaveLength(2);

        // A later call by the same person closes both; identical content collapses into the first.
        await recordFinanceViewCall(expenseCall({ pageView: null, viewedAt: at(5 * 60_000), records: [] }), client);
        const pageRows = rows.filter((r) => r.pagePath === PAGE);
        expect(pageRows).toHaveLength(1);
        expect(pageRows[0]).toMatchObject({ pageViewId: "pv-1", viewedAt: T0, recordCount: 1, mergedPageViewIds: ["pv-2"], closesAt: null });
        expect(parseCalls(pageRows[0].calls).map((c) => c.query)).toEqual([{}, { from: "list" }]);
    });

    test("an open row closes 30 s after its first call; a closed row stays closed", async () => {
        const { rows, client } = makeDb();
        await recordFinanceViewCall(expenseCall(), client);
        expect(rows[0].closesAt).toEqual(at(PAGE_VIEW_MERGE_MS));

        await recordFinanceViewCall(expenseCall({ pageView: null, viewedAt: at(PAGE_VIEW_MERGE_MS + 1), records: [] }), client);
        expect(rows[0].closesAt).toBeNull();
        expect(rows[0].viewKey).toMatch(/^[0-9a-f]{64}$/);
    });

    describe("an id collapsed into another row stays bound to its first user", () => {
        const collapsePv2 = async (client: DbClient) => {
            await recordFinanceViewCall(expenseCall(), client);
            await recordFinanceViewCall(expenseCall({ pageView: { id: "pv-2", path: PAGE }, viewedAt: at(1000) }), client);
            await recordFinanceViewCall(expenseCall({ pageView: null, viewedAt: at(5 * 60_000), records: [] }), client);
        };

        test("another person's call with the id writes an untagged row", async () => {
            const { rows, client } = makeDb();
            await collapsePv2(client);
            expect(rows.some((r) => r.pageViewId === "pv-2")).toBe(false);

            await recordFinanceViewCall(expenseCall({ actorId: 7, pageView: { id: "pv-2", path: PAGE }, viewedAt: at(6 * 60_000) }), client);
            const theirs = rows.filter((r) => r.actorId === 7);
            expect(theirs).toHaveLength(1);
            expect(theirs[0].pageViewId).toBeUndefined();
        });

        test("another path under the id writes an untagged row", async () => {
            const { rows, client } = makeDb();
            await collapsePv2(client);
            await recordFinanceViewCall(expenseCall({ pageView: { id: "pv-2", path: "/finance/review" }, viewedAt: at(6 * 60_000) }), client);
            expect(rows.filter((r) => r.pageViewId === "pv-2")).toHaveLength(0);
        });

        test("the first user's late call on the same path starts a new page-view row on the id", async () => {
            const { rows, client } = makeDb();
            await collapsePv2(client);
            await recordFinanceViewCall(expenseCall({ pageView: { id: "pv-2", path: PAGE }, viewedAt: at(6 * 60_000) }), client);
            expect(rows.filter((r) => r.pageViewId === "pv-2").map((r) => r.pagePath)).toEqual([PAGE]);
        });
    });

    test("a half-built entry neither collapses into nor blocks a finished one with its current content", async () => {
        const { rows, client } = makeDb();
        await recordFinanceViewCall(expenseCall(), client);
        // pv-2 opens after pv-1 closes, with pv-1's content so far, then grows.
        await recordFinanceViewCall(expenseCall({ pageView: { id: "pv-2", path: PAGE }, viewedAt: at(40_000) }), client);
        expect(rows.find((r) => r.pageViewId === "pv-1")?.viewKey).toBe(pageViewKey(PAGE, parseRecords(rows[0].records)));
        expect(rows).toHaveLength(2);

        await recordFinanceViewCall(panelCall({ pageView: { id: "pv-2", path: PAGE }, viewedAt: at(45_000) }), client);
        await recordFinanceViewCall(expenseCall({ pageView: null, viewedAt: at(5 * 60_000), records: [] }), client);

        const pageRows = rows.filter((r) => r.pagePath === PAGE);
        expect(pageRows).toHaveLength(2);
        expect(parseRecords(pageRows[1].records)[0].fields).toContain("reimburseePersonId");
        expect(pageRows[1].viewKey).not.toBe(pageRows[0].viewKey);
    });

    test("a finished duplicate in another window is kept", async () => {
        const { rows, client } = makeDb();
        await recordFinanceViewCall(expenseCall({ viewedAt: new Date("2026-11-06T14:14:50.000Z") }), client);
        await recordFinanceViewCall(expenseCall({ pageView: { id: "pv-2", path: PAGE }, viewedAt: new Date("2026-11-06T14:15:10.000Z") }), client);
        await recordFinanceViewCall(expenseCall({ pageView: null, viewedAt: new Date("2026-11-06T14:30:00.000Z"), records: [] }), client);
        expect(rows.filter((r) => r.pagePath === PAGE)).toHaveLength(2);
    });

    test("another person's finished rows are left for that person's next call", async () => {
        const { rows, client } = makeDb();
        await recordFinanceViewCall(expenseCall(), client);
        await recordFinanceViewCall(expenseCall({ actorId: 7, pageView: null, viewedAt: at(5 * 60_000) }), client);
        expect(String(rows[0].viewKey).startsWith(OPEN_VIEW_KEY_PREFIX)).toBe(true);
    });

    test("takes the person lock, then the page-view lock", async () => {
        const { db, client } = makeDb();
        await recordFinanceViewCall(expenseCall(), client);
        expect(db.$executeRaw).toHaveBeenCalledTimes(2);
        expect(db.$transaction).toHaveBeenCalledTimes(1);
    });

    test("rethrows a database failure", async () => {
        const { db, client } = makeDb();
        db.financeViewLog.create.mockRejectedValue(new Error("connection lost"));
        await expect(recordFinanceViewCall(expenseCall(), client)).rejects.toThrow("connection lost");
    });
});

describe("parseRecords / parseCalls", () => {
    test("read back what is stored", () => {
        expect(parseRecords([{ ref: "Expense:e_1", fields: ["a"] }])).toEqual([{ ref: "Expense:e_1", fields: ["a"] }]);
        expect(parseCalls([{ endpoint: "GET /x", path: "/x", query: { tab: "a" }, role: "r" }]))
            .toEqual([{ endpoint: "GET /x", path: "/x", query: { tab: "a" }, role: "r" }]);
        expect(parseRecords(null)).toEqual([]);
    });

    test.each([
        ["not a list", { ref: "x" }],
        ["a record without fields", [{ ref: "x" }]],
        ["a non-string field", [{ ref: "x", fields: [1] }]],
    ])("refuse %s", (_label, value) => {
        expect(() => parseRecords(value)).toThrow();
    });

    test("refuse a call with a non-string query value", () => {
        expect(() => parseCalls([{ endpoint: "GET /x", path: "/x", query: { n: 1 }, role: "r" }])).toThrow();
    });
});
