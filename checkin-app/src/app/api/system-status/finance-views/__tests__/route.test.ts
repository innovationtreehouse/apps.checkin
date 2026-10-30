/**
 * @jest-environment node
 *
 * The Board's finance view log route (B11): the filters reach the query, the
 * bag always carries both keys, a 51st row signals another page, and viewer
 * names come from Person as id and name only.
 */
import { getServerSession } from "next-auth/next";
import prisma from "@/lib/prisma";
import { GET } from "../route";

jest.mock("next-auth/next", () => ({ getServerSession: jest.fn() }));
jest.mock("@/lib/auth-options", () => ({ authOptions: {} }));
jest.mock("@/lib/prisma", () => ({
    __esModule: true,
    default: {
        financeViewLog: { findMany: jest.fn(), groupBy: jest.fn() },
        person: { findMany: jest.fn() },
    },
}));

const db = prisma as unknown as {
    financeViewLog: { findMany: jest.Mock; groupBy: jest.Mock };
    person: { findMany: jest.Mock };
};
const mockSession = getServerSession as jest.Mock;
const BOARD = { user: { id: 42, isSysadmin: false, isBoardMember: true } };
const SYSADMIN = { user: { id: 99, isSysadmin: true, isBoardMember: false } };

function logRow(id: number) {
    return {
        id,
        viewedAt: new Date("2026-10-27T14:05:00.000Z"),
        actorId: 12,
        role: "isFinance",
        endpoint: "GET /api/expense/finance-queue",
        params: {},
        recordIds: ["e_1"],
        rowCount: 1,
        window: new Date("2026-10-27T14:00:00.000Z"),
        viewKey: "ab12",
    };
}

const get = (qs = "") =>
    GET(new Request(`http://localhost/api/system-status/finance-views${qs}`) as unknown as import("next/server").NextRequest);

const where = () => db.financeViewLog.findMany.mock.calls[0][0].where;

beforeEach(() => {
    jest.clearAllMocks();
    mockSession.mockResolvedValue(BOARD);
    db.financeViewLog.findMany.mockResolvedValue([logRow(1)]);
    db.financeViewLog.groupBy.mockResolvedValue([{ actorId: 12 }]);
    db.person.findMany.mockResolvedValue([{ id: 12, name: "Pat Lee" }]);
});

describe("GET /api/system-status/finance-views", () => {
    it("refuses a sysadmin", async () => {
        mockSession.mockResolvedValue(SYSADMIN);
        expect((await get()).status).toBe(403);
        expect(db.financeViewLog.findMany).not.toHaveBeenCalled();
    });

    it("reads newest first, fifty a page plus one", async () => {
        await get("?page=3");
        expect(db.financeViewLog.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                orderBy: [{ viewedAt: "desc" }, { id: "desc" }],
                skip: 100,
                take: 51,
            }),
        );
    });

    it("returns the log rows and the viewers' names", async () => {
        const body = await (await get()).json();
        expect(body.FinanceViewLog).toHaveLength(1);
        expect(body.Person).toEqual([{ id: 12, name: "Pat Lee" }]);
        expect(db.person.findMany).toHaveBeenCalledWith({
            where: { id: { in: [12] } },
            select: { id: true, name: true },
        });
    });

    it("keeps both keys when the log is empty", async () => {
        db.financeViewLog.findMany.mockResolvedValue([]);
        db.financeViewLog.groupBy.mockResolvedValue([]);
        const body = await (await get()).json();
        expect(body).toEqual({ FinanceViewLog: [], Person: [] });
        expect(db.person.findMany).not.toHaveBeenCalled();
    });

    it("passes a 51st row through to signal another page", async () => {
        db.financeViewLog.findMany.mockResolvedValue(Array.from({ length: 51 }, (_, i) => logRow(i + 1)));
        const body = await (await get()).json();
        expect(body.FinanceViewLog).toHaveLength(51);
    });

    it("filters by person", async () => {
        await get("?person=12");
        expect(where()).toEqual({ AND: [{ actorId: 12 }] });
    });

    it("filters by record id through array containment", async () => {
        await get("?record=%20r_1%20");
        expect(where()).toEqual({ AND: [{ recordIds: { has: "r_1" } }] });
    });

    it("filters by an inclusive day range on viewedAt", async () => {
        await get("?from=2026-10-01&to=2026-10-31");
        const [{ viewedAt }] = where().AND;
        expect(viewedAt.gte).toEqual(new Date("2026-10-01T00:00:00.000"));
        expect(viewedAt.lte).toEqual(new Date("2026-10-31T23:59:59.999"));
    });

    it("filters by record kind on the endpoint's path prefix", async () => {
        await get("?kind=receipts");
        expect(where()).toEqual({
            AND: [{
                OR: [
                    { OR: [{ endpoint: "GET /api/receipts" }, { endpoint: { startsWith: "GET /api/receipts/" } }] },
                    { OR: [{ endpoint: "GET /api/workflow-mapping" }, { endpoint: { startsWith: "GET /api/workflow-mapping/" } }] },
                ],
            }],
        });
    });

    it("keeps gifts of goods out of donations", async () => {
        await get("?kind=donations");
        expect(where().AND[0].NOT).toEqual([
            { OR: [{ endpoint: "GET /api/donations/in-kind" }, { endpoint: { startsWith: "GET /api/donations/in-kind/" } }] },
        ]);
    });

    it.each([
        ["an unknown kind", "?kind=tools", "Invalid record kind."],
        ["a non-numeric person", "?person=pat", "Invalid person."],
        ["a malformed date", "?from=27-10-2026", "Invalid from date."],
    ])("refuses %s", async (_label, qs, error) => {
        const res = await get(qs);
        expect(res.status).toBe(400);
        expect((await res.json()).error).toBe(error);
    });
});
