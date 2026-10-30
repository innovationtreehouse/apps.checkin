/**
 * @jest-environment node
 */
/**
 * Integration tier for recordFinanceView: the unique index and the
 * skip-duplicates insert against a real Postgres.
 */
import prisma from "@/lib/prisma";
import { recordFinanceView, type FinanceView } from "@/lib/finance/financeViewLog";

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

beforeEach(async () => {
    await prisma.financeViewLog.deleteMany({ where: { endpoint } });
});

afterAll(async () => {
    await prisma.financeViewLog.deleteMany({ where: { endpoint } });
});

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
