import { collectLibraryCounts, type LibraryCountProvider } from "../navLibraryCounts";
import { foldBadges, libraryCount, sectionBadges, sectionTabBadge } from "@/components/navBadges";
import type { TodoCounts } from "@/app/api/nav/todo-counts/route";

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
