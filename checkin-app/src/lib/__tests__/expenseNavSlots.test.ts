import { EXPENSE_OPS_TABS, MY_PROGRAMS_LIBRARY_TABS, expenseOpsTabs, visibleLibraryTabs } from "../libraryNav";
import { LIBRARY_COUNT_PROVIDERS } from "../navLibraryCounts";
import { LIBRARY_KEYS } from "@/lib/libraryRelease";
import type { TodoCounts } from "@/app/api/nav/todo-counts/route";
import type { SessionUser } from "@/types/auth";

const counts = (releasedLibraries: string[], libraries?: TodoCounts["libraries"]) =>
  ({
    member: { household: [], programs: [], programsAwaitingFinance: 0 },
    building: 0,
    buildingHousehold: 0,
    buildingReachable: true,
    activePrograms: 0,
    releasedLibraries,
    libraries,
  }) as TodoCounts;

const released = counts([...LIBRARY_KEYS]);
const unreleased = counts(LIBRARY_KEYS.filter((k) => k !== "expense"));

const finance: SessionUser = { id: 1, isFinance: true };
const board: SessionUser = { id: 2, isBoardMember: true };
const lead: SessionUser = { id: 3, programsLed: [9] };
const member: SessionUser = { id: 4 };

const names = (tabs: { name: string }[]) => tabs.map((t) => t.name);

describe("Expense Ops tabs", () => {
  it("shows Expenses then Settings to FINANCE and Board", () => {
    expect(names(expenseOpsTabs(finance, released))).toEqual(["Expenses", "Settings"]);
    expect(names(expenseOpsTabs(board, released))).toEqual(["Expenses", "Settings"]);
    expect(expenseOpsTabs(finance, released).map((t) => t.href)).toEqual(["/expense", "/expense/settings"]);
  });

  it("hides them from a program lead and a plain member", () => {
    expect(expenseOpsTabs(lead, released)).toEqual([]);
    expect(expenseOpsTabs(member, released)).toEqual([]);
  });

  it("hides them from FINANCE until expense is released, and keeps them for Board", () => {
    expect(expenseOpsTabs(finance, unreleased)).toEqual([]);
    expect(names(expenseOpsTabs(board, unreleased))).toEqual(["Expenses", "Settings"]);
  });

  it("badges Expenses with holds plus open flags", () => {
    const [expenses] = EXPENSE_OPS_TABS;
    expect(expenses.badge?.(counts([...LIBRARY_KEYS], { expense: { holds: 2, openFlags: 1 } }))).toEqual({
      count: 3,
      color: "red",
      label: "3 expense holds and flags",
    });
    expect(expenses.badge?.(released)).toBeNull();
  });
});

describe("My Programs Expense approvals tab", () => {
  it("shows to a program lead and not to FINANCE or a plain member", () => {
    expect(names(visibleLibraryTabs(MY_PROGRAMS_LIBRARY_TABS, lead, released))).toEqual(["Expense approvals"]);
    expect(visibleLibraryTabs(MY_PROGRAMS_LIBRARY_TABS, finance, released)).toEqual([]);
    expect(visibleLibraryTabs(MY_PROGRAMS_LIBRARY_TABS, member, released)).toEqual([]);
  });

  it("hides from a program lead until expense is released", () => {
    expect(visibleLibraryTabs(MY_PROGRAMS_LIBRARY_TABS, lead, unreleased)).toEqual([]);
  });

  it("badges with lines awaiting the viewer's sign-off", () => {
    const [approvals] = MY_PROGRAMS_LIBRARY_TABS;
    expect(approvals.badge?.(counts([...LIBRARY_KEYS], { expense: { awaitingMySignoff: 2 } }))).toEqual({
      count: 2,
      color: "treehouseGreen",
      label: "2 expense lines awaiting your sign-off",
    });
  });
});

describe("expense count provider", () => {
  const provider = LIBRARY_COUNT_PROVIDERS.find((p) => p.library === "expense");

  it("is registered for FINANCE, Board and program leads only", () => {
    expect(provider).toBeDefined();
    expect([finance, board, lead, member].map((u) => provider?.visible(u))).toEqual([true, true, true, false]);
  });

  it("contributes no counts when the expense database is not configured", async () => {
    const saved = process.env.EXPENSE_DATABASE_URL;
    delete process.env.EXPENSE_DATABASE_URL;
    try {
      expect(await provider?.count(finance)).toEqual({});
    } finally {
      if (saved !== undefined) process.env.EXPENSE_DATABASE_URL = saved;
    }
  });
});
