import { visibleLinks } from "@/lib/nav/gates";
import { EXPENSE_OPS } from "@/lib/nav/sections/expenseOps";
import { PROGRAMS_I_LEAD } from "@/lib/nav/sections/programsILead";
import { LIBRARY_COUNT_PROVIDERS } from "../navLibraryCounts";
import { LIBRARY_KEYS } from "@/lib/libraryRelease";
import type { TodoCounts } from "@/lib/nav/todoCounts";
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

const TABS = ["Expenses", "Holds", "Flags", "Account Mapping", "QuickBooks Accounts", "Part Buckets", "Capital Seed", "Budgets", "Settings"];

const names = (tabs: { name: string }[]) => tabs.map((t) => t.name);

describe("Expense Ops tabs", () => {
  it("shows the expense screens, Budgets, then Settings to FINANCE and Board", () => {
    expect(names(visibleLinks(EXPENSE_OPS, finance, released))).toEqual(TABS);
    expect(names(visibleLinks(EXPENSE_OPS, board, released))).toEqual(TABS);
    expect(visibleLinks(EXPENSE_OPS, finance, released).map((t) => t.href)[0]).toBe("/expense/expenses");
  });

  it("hides them from a program lead and a plain member", () => {
    expect(visibleLinks(EXPENSE_OPS, lead, released)).toEqual([]);
    expect(visibleLinks(EXPENSE_OPS, member, released)).toEqual([]);
  });

  it("hides them from FINANCE until expense is released, and keeps them for Board", () => {
    expect(visibleLinks(EXPENSE_OPS, finance, unreleased)).toEqual([]);
    expect(names(visibleLinks(EXPENSE_OPS, board, unreleased))).toEqual(TABS);
  });

  it("badges Holds and Flags with their own counts, and nothing else", () => {
    const c = counts([...LIBRARY_KEYS], { expense: { holds: 2, openFlags: 1 } });
    const badges = Object.fromEntries(EXPENSE_OPS.links.map((t) => [t.name, t.badge?.(c) ?? null]));
    expect(badges.Holds).toEqual({ count: 2, color: "red", label: "2 expense holds" });
    expect(badges.Flags).toEqual({ count: 1, color: "red", label: "1 open expense flags" });
    expect(Object.values(badges).filter(Boolean)).toHaveLength(2);
    expect(EXPENSE_OPS.links.map((t) => t.badge?.(released) ?? null).filter(Boolean)).toEqual([]);
  });
});

describe("Programs I Lead library tabs", () => {
  const approver = counts([...LIBRARY_KEYS], { expense: { approver: 1 } });

  it("shows to a bucket approver and not to a program lead who approves none, FINANCE or a plain member", () => {
    expect(names(visibleLinks(PROGRAMS_I_LEAD, member, approver))).toEqual(["Expense approvals", "In-kind gifts"]);
    expect(visibleLinks(PROGRAMS_I_LEAD, lead, released)).toEqual([]);
    expect(visibleLinks(PROGRAMS_I_LEAD, finance, released)).toEqual([]);
    expect(visibleLinks(PROGRAMS_I_LEAD, member, released)).toEqual([]);
  });

  it("hides Expense approvals from a bucket approver until expense is released", () => {
    const approverUnreleased = counts(LIBRARY_KEYS.filter((k) => k !== "expense"), { expense: { approver: 1 } });
    expect(names(visibleLinks(PROGRAMS_I_LEAD, member, approverUnreleased))).toEqual(["In-kind gifts"]);
  });

  it("badges with lines awaiting the viewer's sign-off", () => {
    const approvals = PROGRAMS_I_LEAD.links.find((l) => l.href === "/programs-i-lead/expense-approvals");
    expect(approvals?.badge?.(counts([...LIBRARY_KEYS], { expense: { awaitingMySignoff: 2 } }))).toEqual({
      count: 2,
      color: "treehouseGreen",
      label: "2 expense lines awaiting your sign-off",
    });
  });
});

describe("expense count provider", () => {
  const provider = LIBRARY_COUNT_PROVIDERS.find((p) => p.library === "expense");

  it("is registered for every signed-in person, so a bucket approver gets the approver count", () => {
    expect(provider).toBeDefined();
    expect([finance, board, lead, member].map((u) => provider?.visible(u))).toEqual([true, true, true, true]);
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
