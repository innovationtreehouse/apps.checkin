/**
 * @jest-environment node
 *
 * The Board's finance view log route (B11): the filters and the `before`
 * marker reach the query, the bag always carries both keys, a 51st row signals
 * an older page, and viewer names come from Person as id and name only.
 */
import { getServerSession } from "next-auth/next";
import prisma from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { GET } from "../route";

jest.mock("next-auth/next", () => ({ getServerSession: jest.fn() }));
jest.mock("@/lib/auth-options", () => ({ authOptions: {} }));
jest.mock("@/lib/prisma", () => ({
    __esModule: true,
    default: {
        $queryRaw: jest.fn(),
        financeViewLog: { findMany: jest.fn(), groupBy: jest.fn() },
        person: { findMany: jest.fn() },
        personMerge: { findMany: jest.fn() },
    },
}));

const db = prisma as unknown as {
    $queryRaw: jest.Mock;
    financeViewLog: { findMany: jest.Mock; groupBy: jest.Mock };
    person: { findMany: jest.Mock };
    personMerge: { findMany: jest.Mock };
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
        endpoint: null,
        recordIds: ["Expense:e_1"],
        pagePath: "/finance/review",
        calls: [{ endpoint: "GET /api/expense/finance-queue", path: "/api/expense/finance-queue", query: {}, role: "isFinance" }],
        records: [{ ref: "Expense:e_1", fields: ["amountCents"] }],
    };
}

const get = (qs = "") =>
    GET(new Request(`http://localhost/api/system-status/finance-views${qs}`) as unknown as import("next/server").NextRequest);

/** The page query's SQL text, whitespace collapsed, and its bound values. */
const query = () => {
    const sql = db.$queryRaw.mock.calls[0][0] as Prisma.Sql;
    return { text: sql.text.replace(/\s+/g, " "), values: sql.values };
};

beforeEach(() => {
    jest.clearAllMocks();
    mockSession.mockResolvedValue(BOARD);
    db.$queryRaw.mockResolvedValue([{ id: 1 }]);
    db.financeViewLog.findMany.mockResolvedValue([logRow(1)]);
    db.financeViewLog.groupBy.mockResolvedValue([{ actorId: 12 }]);
    db.person.findMany.mockResolvedValue([{ id: 12, name: "Pat Lee" }]);
    db.personMerge.findMany.mockResolvedValue([]);
});

describe("GET /api/system-status/finance-views", () => {
    it("refuses a sysadmin", async () => {
        mockSession.mockResolvedValue(SYSADMIN);
        expect((await get()).status).toBe(403);
        expect(db.$queryRaw).not.toHaveBeenCalled();
    });

    it("reads newest first, fifty a page plus one, with no offset", async () => {
        await get("?page=3");
        const { text, values } = query();
        expect(text).toBe('SELECT "id" FROM "FinanceViewLog" ORDER BY "viewedAt" DESC, "id" DESC LIMIT $1');
        expect(values).toEqual([51]);
        expect(db.financeViewLog.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: { in: [1] } },
                orderBy: [{ viewedAt: "desc" }, { id: "desc" }],
            }),
        );
    });

    it("starts after the row a before marker names", async () => {
        await get("?before=1762437900000_7");
        const { text, values } = query();
        expect(text).toContain('("viewedAt" < $1 OR ("viewedAt" = $2 AND "id" < $3))');
        expect(values).toEqual([new Date(1762437900000), new Date(1762437900000), 7, 51]);
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

    it("names a viewer whose row a merge deleted from the merge archive", async () => {
        db.financeViewLog.groupBy.mockResolvedValue([{ actorId: 12 }, { actorId: 30 }]);
        db.personMerge.findMany.mockResolvedValue([{ fromId: 30, toId: 12, snapshot: { name: "Sam Old", email: "sam@example.com" } }]);
        const body = await (await get()).json();
        expect(body.Person).toEqual([{ id: 12, name: "Pat Lee" }, { id: 30, name: "Sam Old" }]);
        expect(db.personMerge.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { fromId: { in: [30] } } }));
    });

    it("keeps both keys when the log is empty", async () => {
        db.$queryRaw.mockResolvedValue([]);
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
        const { text, values } = query();
        expect(text).toContain('WHERE "actorId" = $1');
        expect(values[0]).toBe(12);
    });

    it("filters by record id through array containment", async () => {
        await get("?record=%20Expense:e_1%20");
        const { text, values } = query();
        expect(text).toContain('"recordIds" @> ARRAY[$1]::text[]');
        expect(values[0]).toBe("Expense:e_1");
    });

    it("filters by an inclusive day range on viewedAt", async () => {
        await get("?from=2026-10-01&to=2026-10-31");
        const { text, values } = query();
        expect(text).toContain('"viewedAt" >= $1 AND "viewedAt" <= $2');
        expect(values.slice(0, 2)).toEqual([new Date("2026-10-01T00:00:00.000"), new Date("2026-10-31T23:59:59.999")]);
    });

    it("filters by record type on the model of any record the row names", async () => {
        await get("?kind=QuickBooks.Transaction");
        const { text, values } = query();
        expect(text).toContain('EXISTS (SELECT 1 FROM unnest("recordIds") AS ref WHERE starts_with(ref, $1))');
        expect(values[0]).toBe("QuickBooks.Transaction:");
    });

    it.each([
        ["an unknown record type", "?kind=receipts", "Invalid record type."],
        ["a malformed before marker", "?before=2026-11-06", "Invalid before marker."],
        ["a non-numeric person", "?person=pat", "Invalid person."],
        ["a malformed date", "?from=27-10-2026", "Invalid from date."],
        ["a day the calendar lacks", "?to=2026-02-31", "Invalid to date."],
    ])("refuses %s", async (_label, qs, error) => {
        const res = await get(qs);
        expect(res.status).toBe(400);
        expect((await res.json()).error).toBe(error);
    });
});
