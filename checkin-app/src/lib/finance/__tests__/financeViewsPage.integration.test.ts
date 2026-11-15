/**
 * @jest-environment node
 */
/**
 * Integration tier for the Board's finance view log paging: a page starts after the row its
 * `before` marker names, so a view logged between two pages never repeats a row.
 */
import prisma from "@/lib/prisma";
import { financeViewCursor, parseFinanceViewCursor, recordSearchRefs } from "@/lib/finance/financeViewKinds";
import { financeViewsPageQuery, type FinanceViewsFilter } from "@/lib/finance/financeViewsPage";

const TAG = "finance-views-page-test";
const ACTOR = 900021;
const OTHER_ACTOR = 900022;

const clean = () => prisma.financeViewLog.deleteMany({ where: { actorId: { in: [ACTOR, OTHER_ACTOR] } } });

beforeEach(clean);
afterAll(clean);

let seq = 0;
async function logView(viewedAt: string, recordIds: string[], actorId = ACTOR) {
    seq += 1;
    return prisma.financeViewLog.create({
        data: {
            viewedAt: new Date(viewedAt),
            actorId,
            role: "isFinance",
            recordIds,
            records: recordIds.map((ref) => ({ ref, fields: ["amountCents"] })),
            calls: [],
            recordCount: recordIds.length,
            pagePath: `/${TAG}`,
            window: new Date(viewedAt),
            viewKey: `${TAG}-${seq}`,
        },
    });
}

async function pageIds(filter: FinanceViewsFilter, limit: number): Promise<number[]> {
    const rows = await prisma.$queryRaw<{ id: number }[]>(financeViewsPageQuery({ actorId: ACTOR, ...filter }, limit));
    return rows.map((r) => r.id);
}

describe("financeViewsPageQuery (integration)", () => {
    test("a view logged between two pages repeats no row on the next", async () => {
        const a = await logView("2026-11-06T10:00:00.000Z", ["Expense:e_1"]);
        const b = await logView("2026-11-06T11:00:00.000Z", ["Expense:e_2"]);
        const c = await logView("2026-11-06T12:00:00.000Z", ["Expense:e_3"]);

        const first = await pageIds({}, 2);
        expect(first).toEqual([c.id, b.id]);

        await logView("2026-11-06T13:00:00.000Z", ["Expense:e_4"]);
        const before = parseFinanceViewCursor(financeViewCursor({ id: b.id, viewedAt: b.viewedAt.toISOString() }));
        expect(before).not.toBeNull();
        const second = await pageIds({ before: before ?? undefined }, 2);

        expect(second).toEqual([a.id]);
    });

    test("rows sharing a viewedAt are ordered by id and split across pages without loss", async () => {
        const at = "2026-11-06T10:00:00.000Z";
        const x = await logView(at, ["Receipt:r_1"]);
        const y = await logView(at, ["Receipt:r_2"]);
        const z = await logView(at, ["Receipt:r_3"]);

        const first = await pageIds({}, 2);
        expect(first).toEqual([z.id, y.id]);
        const second = await pageIds({ before: { viewedAt: new Date(at), id: y.id } }, 2);
        expect(second).toEqual([x.id]);
    });

    test("the record type filter matches a row naming any record of that model", async () => {
        const qb = await logView("2026-11-06T10:00:00.000Z", ["Expense:e_1", "QuickBooks.Transaction:4412"]);
        await logView("2026-11-06T11:00:00.000Z", ["Expense:e_2"]);
        await logView("2026-11-06T12:00:00.000Z", ["QuickBooksish:1"]);

        expect(await pageIds({ model: "QuickBooks.Transaction" }, 10)).toEqual([qb.id]);
    });

    test("a record search finds an older row's bare id and a newer row's ref, typed either way", async () => {
        const older = await logView("2026-11-06T10:00:00.000Z", ["e_123"]);
        const newer = await logView("2026-11-06T11:00:00.000Z", ["Expense:e_123", "Receipt:r_9"]);
        await logView("2026-11-06T12:00:00.000Z", ["Expense:e_1234", "e_12"]);
        await logView("2026-11-06T13:00:00.000Z", ["Expense:e_123"], OTHER_ACTOR);

        expect(await pageIds({ records: recordSearchRefs("e_123") }, 10)).toEqual([newer.id, older.id]);
        expect(await pageIds({ records: recordSearchRefs("Expense:e_123") }, 10)).toEqual([newer.id, older.id]);
    });
});
