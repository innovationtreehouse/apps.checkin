/**
 * @jest-environment node
 */
/**
 * Integration tier for the finance view log writers: the unique index, the
 * skip-duplicates insert, and the page-view merge's locks against a real Postgres.
 */
import prisma from "@/lib/prisma";
import {
    OPEN_VIEW_KEY_PREFIX,
    PAGE_VIEW_MERGE_MS,
    parseCalls,
    parseRecords,
    recordFinanceView,
    recordFinanceViewCall,
    type FinanceView,
    type FinanceViewCall,
} from "@/lib/finance/financeViewLog";

const TAG = "finance-view-log-test";
const endpoint = `GET /api/${TAG}/[id]`;

const view: FinanceView = {
    actorId: 900001,
    role: "isFinance",
    endpoint,
    params: { id: "r_1" },
    recordIds: ["r_2", "r_1"],
    rowCount: 2,
};

const rows = () => prisma.financeViewLog.findMany({ where: { endpoint }, orderBy: { id: "asc" } });

// Page-view rows carry no endpoint; they are cleaned by these test-only actor ids.
const PAGE_ACTORS = [900011, 900012];
const pageViewId = `${TAG}-pv`;
const PAGE = `/${TAG}/expenses/e_1`;

const clean = () =>
    prisma.financeViewLog.deleteMany({ where: { OR: [{ endpoint }, { actorId: { in: PAGE_ACTORS } }] } });

beforeEach(clean);
afterAll(clean);

describe("recordFinanceView (integration)", () => {
    test("a repeat in the same window, ids reordered, adds nothing and keeps the first time", async () => {
        await recordFinanceView({ ...view, viewedAt: new Date("2026-10-27T14:01:00Z") });
        await recordFinanceView({ ...view, recordIds: ["r_1", "r_2"], viewedAt: new Date("2026-10-27T14:14:00Z") });

        const written = await rows();
        expect(written).toHaveLength(1);
        expect(written[0].viewedAt.toISOString()).toBe("2026-10-27T14:01:00.000Z");
        expect(written[0].window.toISOString()).toBe("2026-10-27T14:00:00.000Z");
        expect(written[0].recordIds).toEqual(["r_2", "r_1"]);
        expect(written[0].params).toEqual({ id: "r_1" });
    });

    test("the next window, another person, or other records each add a row", async () => {
        const viewedAt = new Date("2026-10-27T14:01:00Z");
        await recordFinanceView({ ...view, viewedAt });
        await recordFinanceView({ ...view, viewedAt: new Date("2026-10-27T14:15:00Z") });
        await recordFinanceView({ ...view, actorId: 900002, viewedAt });
        await recordFinanceView({ ...view, recordIds: ["r_3"], viewedAt });

        expect(await rows()).toHaveLength(4);
    });

    test("the GIN index answers who looked at a record", async () => {
        await recordFinanceView({ ...view, viewedAt: new Date("2026-10-27T14:01:00Z") });
        const hits = await prisma.financeViewLog.findMany({ where: { endpoint, recordIds: { has: "r_2" } } });
        expect(hits.map((r) => r.actorId)).toEqual([900001]);
    });
});

describe("recordFinanceViewCall (integration)", () => {
    const T0 = new Date("2026-11-06T14:05:00.000Z");
    const call = (over: Partial<FinanceViewCall>): FinanceViewCall => ({
        actorId: PAGE_ACTORS[0],
        role: "isFinance",
        endpoint: `GET /api/${TAG}/[id]`,
        path: `/api/${TAG}/e_1`,
        query: {},
        records: [{ ref: "Expense:e_1", fields: ["receiptTotalCents"] }],
        pageView: { id: pageViewId, path: PAGE },
        viewedAt: T0,
        ...over,
    });
    const pageRows = () =>
        prisma.financeViewLog.findMany({ where: { actorId: { in: PAGE_ACTORS } }, orderBy: { id: "asc" } });

    test("concurrent calls of one page view merge into one row, losing no record", async () => {
        await Promise.all(Array.from({ length: 5 }, (_, i) => recordFinanceViewCall(call({
            path: `/api/${TAG}/e_1/panel-${i}`,
            records: [{ ref: `Expense:e_1`, fields: [`field${i}`] }, { ref: `Receipt:r_${i}`, fields: ["receiptTotalCents"] }],
            viewedAt: new Date(T0.getTime() + i * 100),
        }))));

        const written = await pageRows();
        expect(written).toHaveLength(1);
        const [row] = written;
        expect(row).toMatchObject({ pagePath: PAGE, pageViewId, recordCount: 6, endpoint: null, params: null, rowCount: null });
        expect(row.viewKey.startsWith(OPEN_VIEW_KEY_PREFIX)).toBe(true);
        expect(parseCalls(row.calls)).toHaveLength(5);
        expect(parseRecords(row.records).find((r) => r.ref === "Expense:e_1")?.fields)
            .toEqual(["field0", "field1", "field2", "field3", "field4"]);
    });

    test("a finished reload identical to an earlier page view collapses into it", async () => {
        await recordFinanceViewCall(call({}));
        await recordFinanceViewCall(call({ pageView: { id: `${pageViewId}-reload`, path: PAGE }, viewedAt: new Date(T0.getTime() + 1000) }));
        await recordFinanceViewCall(call({ pageView: null, records: [], viewedAt: new Date(T0.getTime() + 5 * 60_000) }));

        const written = (await pageRows()).filter((r) => r.pagePath === PAGE);
        expect(written).toHaveLength(1);
        expect(written[0].viewKey).toMatch(/^[0-9a-f]{64}$/);
        expect(written[0].pageViewId).toBe(pageViewId);
    });

    test("an id collapsed into an earlier row stays bound to its first user", async () => {
        const reload = `${pageViewId}-reload`;
        await recordFinanceViewCall(call({}));
        await recordFinanceViewCall(call({ pageView: { id: reload, path: PAGE }, viewedAt: new Date(T0.getTime() + 1000) }));
        await recordFinanceViewCall(call({ pageView: null, records: [], viewedAt: new Date(T0.getTime() + 5 * 60_000) }));
        await recordFinanceViewCall(call({ actorId: PAGE_ACTORS[1], pageView: { id: reload, path: PAGE }, viewedAt: new Date(T0.getTime() + 6 * 60_000) }));

        const written = await pageRows();
        expect(written.find((r) => r.pagePath === PAGE)?.mergedPageViewIds).toEqual([reload]);
        const theirs = written.filter((r) => r.actorId === PAGE_ACTORS[1]);
        expect(theirs.map((r) => r.pageViewId)).toEqual([null]);
    });

    test("another person's call on the id, or a call past the window, never joins the row", async () => {
        await recordFinanceViewCall(call({}));
        await recordFinanceViewCall(call({ actorId: PAGE_ACTORS[1], records: [{ ref: "Expense:e_2", fields: ["submitterId"] }] }));
        await recordFinanceViewCall(call({ viewedAt: new Date(T0.getTime() + PAGE_VIEW_MERGE_MS + 1), records: [{ ref: "Expense:e_3", fields: [] }] }));

        const written = await pageRows();
        expect(written.map((r) => [r.actorId, r.pageViewId, r.recordIds])).toEqual([
            [PAGE_ACTORS[0], pageViewId, ["Expense:e_1"]],
            [PAGE_ACTORS[1], null, ["Expense:e_2"]],
            [PAGE_ACTORS[0], pageViewId, ["Expense:e_3"]],
        ]);
    });

    test("the record search finds a page-view row by its ref", async () => {
        await recordFinanceViewCall(call({}));
        const hits = await prisma.financeViewLog.findMany({
            where: { actorId: { in: PAGE_ACTORS }, recordIds: { has: "Expense:e_1" } },
        });
        expect(hits).toHaveLength(1);
    });
});
