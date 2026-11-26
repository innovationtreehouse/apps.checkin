import {
    type Candidate,
    type FillDb,
    type GraphqlPost,
    type OrderRead,
    type ReadOrder,
    checkPicks,
    formatBoardList,
    orderReader,
    parseArgs,
    parsePicks,
    resolveAll,
    resolveCandidate,
    run,
} from "../membership-year-order-fill";

const V2024 = "9001";
const V2025 = "9002";
const VARIANT_YEARS = new Map([
    [V2024, 2024],
    [V2025, 2025],
]);
const PROGRAM_VARIANT = "5551";

function candidate(over: Partial<Candidate> = {}): Candidate {
    return { id: 1, kind: "RENEWAL", paidAt: new Date("2025-07-30T15:00:00Z"), shopifyOrderId: "777", householdId: 40, householdName: "Rivera", ...over };
}

function ordersReader(orders: Record<string, (string | null)[]>): ReadOrder & jest.Mock {
    return jest.fn(async (id: string): Promise<OrderRead> => (id in orders ? { found: true, lineVariantIds: orders[id] } : { found: false }));
}

type ProcessRow = {
    id: number;
    kind: "INITIAL" | "RENEWAL";
    paidAt: Date | null;
    shopifyOrderId: string | null;
    appliesToYear: number | null;
    household: { id: number; name: string } | null;
};

/** An in-memory stand-in for the three tables the script reads, with writes recorded. */
function fakeDb(rows: ProcessRow[], opts: { boardMemberIds?: number[] } = {}) {
    const audits: { data: Record<string, unknown> }[] = [];
    const isOpen = (r: ProcessRow) => r.paidAt !== null && r.appliesToYear === null;
    const updateMany = jest.fn(async ({ where, data }: { where: { id: number }; data: { appliesToYear: number } }) => {
        const row = rows.find((r) => r.id === where.id && isOpen(r));
        if (!row) return { count: 0 };
        row.appliesToYear = data.appliesToYear;
        return { count: 1 };
    });
    const tx = { orgMembershipProcess: { updateMany }, auditLog: { create: jest.fn(async (arg: { data: Record<string, unknown> }) => audits.push(arg)) } };
    const db = {
        orgMembershipProcess: {
            findMany: jest.fn(async () =>
                rows.filter(isOpen).map((r) => ({ id: r.id, kind: r.kind, paidAt: r.paidAt, shopifyOrderId: r.shopifyOrderId, orgMembership: r.household ? { household: r.household } : null })),
            ),
            updateMany,
        },
        membershipYearVariant: { findMany: jest.fn(async () => [...VARIANT_YEARS].map(([shopifyVariantId, membershipYear]) => ({ shopifyVariantId, membershipYear }))) },
        person: { findMany: jest.fn(async ({ where }: { where: { id: { in: number[] } } }) => where.id.in.filter((id) => (opts.boardMemberIds ?? []).includes(id)).map((id) => ({ id }))) },
        $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    };
    return { db: db as unknown as FillDb, rows, audits, updateMany };
}

function row(over: Partial<ProcessRow> = {}): ProcessRow {
    return { id: 1, kind: "RENEWAL", paidAt: new Date("2025-07-30T15:00:00Z"), shopifyOrderId: "777", appliesToYear: null, household: { id: 40, name: "Rivera" }, ...over };
}

describe("resolveCandidate", () => {
    it("takes the year of the one membership variant on the order, not the year at paidAt", async () => {
        const read = ordersReader({ "777": [PROGRAM_VARIANT, V2024] });
        await expect(resolveCandidate(candidate(), VARIANT_YEARS, read)).resolves.toMatchObject({ outcome: "order", year: 2024, shopifyOrderId: "777", shopifyVariantId: V2024 });
    });

    it("treats two lines of the same variant as one match", async () => {
        const read = ordersReader({ "777": [V2025, V2025] });
        await expect(resolveCandidate(candidate(), VARIANT_YEARS, read)).resolves.toMatchObject({ outcome: "order", year: 2025 });
    });

    it.each([
        ["no order is recorded", candidate({ shopifyOrderId: null }), {}, "no-order"],
        ["the order id is blank", candidate({ shopifyOrderId: "  " }), {}, "no-order"],
        ["Shopify can't find the order", candidate(), {}, "order-not-found"],
        ["the order id isn't a Shopify number", candidate({ shopifyOrderId: "#1042" }), {}, "order-not-found"],
        ["the order carries no membership variant", candidate(), { "777": [PROGRAM_VARIANT] }, "no-membership-variant"],
        ["the membership line's variant was deleted", candidate(), { "777": [null] }, "no-membership-variant"],
        ["the order carries two membership variants", candidate(), { "777": [V2024, V2025] }, "several-membership-variants"],
    ])("lists the row when %s", async (_label, c, orders, reason) => {
        await expect(resolveCandidate(c, VARIANT_YEARS, ordersReader(orders))).resolves.toEqual({ outcome: "listed", candidate: c, reason });
    });

    it("never asks Shopify about a row with no order", async () => {
        const read = ordersReader({});
        await resolveCandidate(candidate({ shopifyOrderId: null }), VARIANT_YEARS, read);
        expect(read).not.toHaveBeenCalled();
    });
});

describe("resolveAll", () => {
    it("lets a Shopify failure stop the run rather than listing the row", async () => {
        const read: ReadOrder = jest.fn(async () => {
            throw new Error("Shopify order read responded with status 503");
        });
        await expect(resolveAll([candidate()], VARIANT_YEARS, read)).rejects.toThrow(/503/);
    });
});

describe("orderReader", () => {
    const page = (variantIds: (string | null)[], next: string | null) => ({
        data: {
            order: {
                lineItems: {
                    pageInfo: { hasNextPage: next !== null, endCursor: next },
                    nodes: variantIds.map((v) => ({ variant: v === null ? null : { legacyResourceId: v } })),
                },
            },
        },
    });

    it("asks for the order by its GID and collects every page of lines", async () => {
        const post: GraphqlPost & jest.Mock = jest.fn().mockResolvedValueOnce(page([PROGRAM_VARIANT], "c1")).mockResolvedValueOnce(page([V2024, null], null));
        await expect(orderReader(post)("777")).resolves.toEqual({ found: true, lineVariantIds: [PROGRAM_VARIANT, V2024, null] });
        expect(post.mock.calls[0][1]).toEqual({ id: "gid://shopify/Order/777", after: null });
        expect(post.mock.calls[1][1]).toEqual({ id: "gid://shopify/Order/777", after: "c1" });
    });

    it("reports an order Shopify returns as null as not found", async () => {
        const post: GraphqlPost = jest.fn().mockResolvedValue({ data: { order: null } });
        await expect(orderReader(post)("777")).resolves.toEqual({ found: false });
    });

    it("throws on a GraphQL error instead of reporting the order missing", async () => {
        const post: GraphqlPost = jest.fn().mockResolvedValue({ errors: [{ message: "Throttled" }] });
        await expect(orderReader(post)("777")).rejects.toThrow(/Throttled/);
    });
});

describe("parsePicks", () => {
    it("reads one pick per line under the header", () => {
        expect(parsePicks("processId,year,boardPersonId\n12,2024,7\r\n13, 2025 ,7\n\n")).toEqual([
            { processId: 12, year: 2024, boardPersonId: 7 },
            { processId: 13, year: 2025, boardPersonId: 7 },
        ]);
    });

    it("refuses a file without the header", () => {
        expect(() => parsePicks("12,2024,7")).toThrow(/header/);
    });

    it("refuses the whole file, naming every bad line", () => {
        let message = "";
        try {
            parsePicks("processId,year,boardPersonId\n12,2024,7\n13,2025\n14,twenty,7\n12,2025,7\n15,2025.5,7");
        } catch (e) {
            message = e instanceof Error ? e.message : "";
        }
        expect(message).toMatch(/line 3/);
        expect(message).toMatch(/line 4/);
        expect(message).toMatch(/line 5: application 12 is picked more than once/);
        expect(message).toMatch(/line 6/);
    });
});

describe("checkPicks", () => {
    const listed = [{ outcome: "listed" as const, candidate: candidate({ id: 12 }), reason: "no-order" as const }];
    const matched = [{ outcome: "order" as const, candidate: candidate({ id: 13 }), year: 2024, shopifyOrderId: "777", shopifyVariantId: V2024 }];

    it("accepts a Board member's pick for a listed row", async () => {
        const { db } = fakeDb([], { boardMemberIds: [7] });
        await expect(checkPicks(db, [{ processId: 12, year: 2024, boardPersonId: 7 }], listed)).resolves.toBeUndefined();
    });

    it("refuses a pick for a row its order settles, or for a row not waiting for a year", async () => {
        const { db } = fakeDb([], { boardMemberIds: [7] });
        await expect(
            checkPicks(db, [{ processId: 13, year: 2025, boardPersonId: 7 }, { processId: 99, year: 2025, boardPersonId: 7 }], [...listed, ...matched]),
        ).rejects.toThrow(/application 13 is not on the Board list[\s\S]*application 99 is not on the Board list/);
    });

    it("refuses a pick by someone who is not a Board member", async () => {
        const { db } = fakeDb([], { boardMemberIds: [7] });
        await expect(checkPicks(db, [{ processId: 12, year: 2024, boardPersonId: 8 }], listed)).rejects.toThrow(/person 8 .* is not a Board member/);
    });
});

describe("formatBoardList", () => {
    it("shows household, kind, paidAt, order and reason, and no year", () => {
        const lines = formatBoardList([
            { outcome: "listed", candidate: candidate({ id: 12 }), reason: "several-membership-variants" },
            { outcome: "listed", candidate: candidate({ id: 13, kind: "INITIAL", shopifyOrderId: null }), reason: "no-order" },
            { outcome: "order", candidate: candidate({ id: 14 }), year: 2024, shopifyOrderId: "777", shopifyVariantId: V2024 },
        ]);
        expect(lines).toEqual([
            "application 12 | household 40 (Rivera) | RENEWAL | paid 2025-07-30T15:00:00.000Z | order 777 | several membership-year variants on the order",
            "application 13 | household 40 (Rivera) | INITIAL | paid 2025-07-30T15:00:00.000Z | no order | no store order recorded",
        ]);
    });
});

describe("parseArgs", () => {
    it("is a dry run by default", () => {
        expect(parseArgs([])).toEqual({ write: false, picksPath: null });
    });

    it("writes only with --write", () => {
        expect(parseArgs(["--picks", "picks.csv", "--write"])).toEqual({ write: true, picksPath: "picks.csv" });
    });

    it.each([[["--wrte"]], [["--picks"]], [["--picks", "--write"]]])("refuses %p", (argv) => {
        expect(() => parseArgs(argv)).toThrow(/argument/);
    });
});

describe("run", () => {
    const noFile = () => {
        throw new Error("no picks file in this run");
    };

    it("writes nothing on a dry run", async () => {
        const { db, rows, audits, updateMany } = fakeDb([row({ id: 1 }), row({ id: 2, shopifyOrderId: null })]);
        const out = await run(db, ordersReader({ "777": [V2024] }), { write: false, picksPath: null }, noFile);

        expect(updateMany).not.toHaveBeenCalled();
        expect(audits).toEqual([]);
        expect(rows.map((r) => r.appliesToYear)).toEqual([null, null]);
        expect(out).toContain("  application 1 -> 2024 (order 777, variant 9001)");
        expect(out.join("\n")).toMatch(/application 2 .* no store order recorded/);
        expect(out.at(-1)).toMatch(/Dry run: nothing written/);
    });

    it("with --write, writes each order's year with a system audit row naming the order and variant", async () => {
        const { db, rows, audits } = fakeDb([row({ id: 1 }), row({ id: 2, shopifyOrderId: "778" }), row({ id: 3, shopifyOrderId: null })]);
        await run(db, ordersReader({ "777": [V2024], "778": [V2024, V2025] }), { write: true, picksPath: null }, noFile);

        expect(rows.map((r) => r.appliesToYear)).toEqual([2024, null, null]);
        expect(audits).toEqual([
            {
                data: {
                    actorId: 0,
                    actorSystem: "migration:membership-year-order-fill",
                    action: "EDIT",
                    tableName: "OrgMembershipProcess",
                    affectedEntityId: 1,
                    oldData: { appliesToYear: null },
                    newData: { appliesToYear: 2024, source: "store order", shopifyOrderId: "777", shopifyVariantId: V2024 },
                },
            },
        ]);
    });

    it("skips a row that gained a year since it was read, with no audit row", async () => {
        const { db, rows, audits, updateMany } = fakeDb([row({ id: 1 })]);
        const read: ReadOrder = async () => {
            rows[0].appliesToYear = 2025;
            return { found: true, lineVariantIds: [V2024] };
        };
        const out = await run(db, read, { write: true, picksPath: null }, noFile);

        expect(updateMany).toHaveBeenCalledTimes(1);
        expect(rows[0].appliesToYear).toBe(2025);
        expect(audits).toEqual([]);
        expect(out).toContain("Wrote 0 year(s); 1 skipped because the row already has a year.");
    });

    it("with --picks and --write, writes each pick with the picking Board member as the actor", async () => {
        const { db, rows, audits } = fakeDb([row({ id: 1 }), row({ id: 2, shopifyOrderId: null }), row({ id: 3, shopifyOrderId: "404" })], { boardMemberIds: [7] });
        const picks = "processId,year,boardPersonId\n2,2025,7";
        const out = await run(db, ordersReader({ "777": [V2024] }), { write: true, picksPath: "picks.csv" }, () => picks);

        expect(rows.map((r) => r.appliesToYear)).toEqual([null, 2025, null]);
        expect(audits).toEqual([
            {
                data: {
                    actorId: 7,
                    actorSystem: null,
                    action: "EDIT",
                    tableName: "OrgMembershipProcess",
                    affectedEntityId: 2,
                    oldData: { appliesToYear: null },
                    newData: { appliesToYear: 2025, source: "Board pick" },
                },
            },
        ]);
        expect(out.join("\n")).toMatch(/Still on the Board list with no pick: 1\n {2}application 3 /);
    });

    it("writes no pick at all when any pick is refused", async () => {
        const { db, rows, updateMany } = fakeDb([row({ id: 2, shopifyOrderId: null }), row({ id: 3, shopifyOrderId: null })], { boardMemberIds: [7] });
        const picks = "processId,year,boardPersonId\n2,2025,7\n3,2025,8";

        await expect(run(db, ordersReader({}), { write: true, picksPath: "picks.csv" }, () => picks)).rejects.toThrow(/person 8/);
        expect(updateMany).not.toHaveBeenCalled();
        expect(rows.map((r) => r.appliesToYear)).toEqual([null, null]);
    });
});
