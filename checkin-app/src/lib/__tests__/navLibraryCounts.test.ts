import { LIBRARY_COUNT_PROVIDERS, collectLibraryCounts, type LibraryCountProvider } from "../navLibraryCounts";

const mockCountAwaitingFinance = jest.fn(async (viewerId: number) => ({
  total: viewerId,
  byState: { financial_review: viewerId - 1, duplicate_flagged: 1, flow_error: 0 },
}));

jest.mock("@checkin/receipt", () => ({
  receiptService: {
    countAwaitingFinance: (viewerId: number) => mockCountAwaitingFinance(viewerId),
    countAwaitingSubmitter: async (id: number) => id * 10,
  },
}));

describe("the receipt provider", () => {
  const receipt = LIBRARY_COUNT_PROVIDERS.filter((p) => p.library === "receipt");

  beforeEach(() => { process.env.RECEIPT_DATABASE_URL = "postgres://receipt"; });
  afterEach(() => { delete process.env.RECEIPT_DATABASE_URL; });

  it("reports the review counts to FINANCE and not to BOARD, which cannot act on the queues", async () => {
    // FINANCE and BOARD may submit receipts too, so each also gets its own count.
    expect(await collectLibraryCounts({ id: 5, isFinance: true }, ["receipt"], receipt)).toEqual({
      receipt: {
        awaitingMe: 50,
        awaitingFinance: 5,
        "awaitingFinance:financial_review": 4,
        "awaitingFinance:duplicate_flagged": 1,
        "awaitingFinance:flow_error": 0,
      },
    });
    expect(mockCountAwaitingFinance).toHaveBeenCalledWith(5);
    expect(await collectLibraryCounts({ id: 1, isBoardMember: true }, ["receipt"], receipt)).toEqual({
      receipt: { awaitingMe: 10 },
    });
    expect(mockCountAwaitingFinance).toHaveBeenCalledTimes(1);
  });

  it("reports an uploader only their own count", async () => {
    const adult = { ageBand: "adult" as const, isActiveOrgMember: true };
    expect(await collectLibraryCounts({ id: 2, ...adult }, ["receipt"], receipt)).toEqual({ receipt: { awaitingMe: 20 } });
  });
});

jest.mock("@checkin/local-inventory", () => ({ getNavCounts: async () => ({ openBackorders: 4 }) }));

describe("the local-inventory provider", () => {
  const inventory = LIBRARY_COUNT_PROVIDERS.filter((p) => p.library === "local-inventory");

  beforeEach(() => { process.env.LOCAL_INVENTORY_DATABASE_URL = "postgres://inventory"; });
  afterEach(() => { delete process.env.LOCAL_INVENTORY_DATABASE_URL; });

  it("reports open backorders to an inventory manager", async () => {
    expect(await collectLibraryCounts({ id: 1, isInventoryManager: true }, ["local-inventory"], inventory)).toEqual({
      "local-inventory": { openBackorders: 4 },
    });
  });

  it("reports nothing to FINANCE or BOARD, which read the queue but cannot receive", async () => {
    for (const u of [{ id: 2, isFinance: true }, { id: 3, isBoardMember: true }, { id: 4 }]) {
      expect(await collectLibraryCounts(u, ["local-inventory"], inventory)).toBeUndefined();
    }
  });

  it("reports no count when the library has no database", async () => {
    delete process.env.LOCAL_INVENTORY_DATABASE_URL;
    expect(await collectLibraryCounts({ id: 1, isInventoryManager: true }, ["local-inventory"], inventory)).toEqual({
      "local-inventory": {},
    });
  });
});
import { foldBadges, libraryCount, sectionBadges, sectionTabBadge } from "@/components/navBadges";
import type { TodoCounts } from "@/lib/nav/todoCounts";

const finance = { id: 1, isFinance: true };
const member = { id: 2 };

const provider = (over: Partial<LibraryCountProvider>): LibraryCountProvider => ({
  library: "expense",
  visible: (u) => !!u.isFinance,
  count: async () => ({ holds: 2 }),
  ...over,
});

describe("collectLibraryCounts", () => {
  it("returns undefined when no provider is registered", async () => {
    expect(await collectLibraryCounts(finance, ["expense", "income"], [])).toBeUndefined();
  });

  it("keys each visible provider's counts by library", async () => {
    const out = await collectLibraryCounts(finance, ["expense", "income"], [
      provider({}),
      provider({ library: "income", count: async () => ({ drift: 1 }) }),
    ]);
    expect(out).toEqual({ expense: { holds: 2 }, income: { drift: 1 } });
  });

  it("omits a library the viewer cannot see, without running its provider", async () => {
    const count = jest.fn(async () => ({ holds: 2 }));
    expect(await collectLibraryCounts(member, ["expense"], [provider({ count })])).toBeUndefined();
    expect(count).not.toHaveBeenCalled();
  });

  it("omits an unreleased library for a non-Board viewer", async () => {
    expect(await collectLibraryCounts(finance, ["income"], [provider({})])).toBeUndefined();
  });

  it("omits a failing provider and keeps the rest", async () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    const out = await collectLibraryCounts(finance, ["expense", "income"], [
      provider({ library: "income", count: async () => { throw new Error("db down"); } }),
      provider({}),
    ]);
    expect(out).toEqual({ expense: { holds: 2 } });
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

describe("library badge pattern", () => {
  const counts = {
    member: { household: [], programs: [], programsAwaitingFinance: 0 },
    building: 0,
    buildingHousehold: 0,
    buildingReachable: true,
    activePrograms: 0,
    libraries: { expense: { holds: 3 } },
  } as TodoCounts;
  const holdsTab = {
    name: "Expenses",
    href: "/expense",
    badge: (c: TodoCounts | null) => {
      const n = libraryCount(c, "expense", "holds");
      return n > 0 ? { count: n, color: "treehouseGreen", label: `${n} holds` } : null;
    },
  };

  it("reads a library count, 0 when absent", () => {
    expect(libraryCount(counts, "expense", "holds")).toBe(3);
    expect(libraryCount(counts, "income", "drift")).toBe(0);
    expect(libraryCount(null, "expense", "holds")).toBe(0);
  });

  it("renders a tab's pill and folds it into the section's pills", () => {
    expect(sectionTabBadge([holdsTab], "/expense", counts)).toEqual({ count: 3, color: "treehouseGreen", label: "3 holds" });
    expect(sectionTabBadge([holdsTab], "/expense", null)).toBeNull();
    expect(sectionBadges("/expense", [holdsTab, holdsTab], counts)).toEqual([
      { count: 6, color: "treehouseGreen", label: "3 holds; 3 holds" },
    ]);
  });

  it("folds to one pill per color", () => {
    expect(
      foldBadges([
        { count: 1, color: "red", label: "a" },
        { count: 2, color: "gray", label: "b" },
        { count: 4, color: "red", label: "c" },
      ]),
    ).toEqual([
      { count: 5, color: "red", label: "a; c" },
      { count: 2, color: "gray", label: "b" },
    ]);
  });
});
