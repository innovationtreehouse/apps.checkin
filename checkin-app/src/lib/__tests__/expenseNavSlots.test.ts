import { visibleLinks } from "@/lib/nav/gates";
import { FINANCE } from "@/lib/nav/sections/finance";
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

const TABS = ["Finance review", "Expenses", "Flow status", "Account Mapping", "QuickBooks Accounts", "Part Buckets", "Capital Seed", "Donated Equipment", "Budgets", "Incoming receipt queue", "Receipt settings"];
const BOARD_TABS = TABS.filter((t) => t !== "Incoming receipt queue");
const EXPENSE_SCREENS = ["Expenses", "Account Mapping", "QuickBooks Accounts", "Part Buckets", "Capital Seed", "Donated Equipment", "Budgets"];

const names = (tabs: { name: string }[]) => tabs.map((t) => t.name);

describe("Finance section", () => {
  it("shows the queue first, then the expense list, flow status, setup screens, budgets, mail and receipt settings", () => {
    expect(names(visibleLinks(FINANCE, finance, released))).toEqual(TABS);
    expect(names(visibleLinks(FINANCE, board, released))).toEqual(BOARD_TABS);
    expect(visibleLinks(FINANCE, finance, released)[0].href).toBe("/finance/review");
  });

  it("hides it from a program lead and a plain member", () => {
    expect(visibleLinks(FINANCE, lead, released)).toEqual([]);
    expect(visibleLinks(FINANCE, member, released)).toEqual([]);
  });

  it("hides the expense screens from FINANCE until expense is released, and keeps them for Board", () => {
    expect(names(visibleLinks(FINANCE, finance, unreleased))).toEqual(TABS.filter((t) => !EXPENSE_SCREENS.includes(t)));
    expect(names(visibleLinks(FINANCE, board, unreleased))).toEqual(BOARD_TABS);
  });

  it("carries one green pill, on Finance review, summing the receipt and expense queue counts", () => {
    const c = counts([...LIBRARY_KEYS], { expense: { financeQueue: 3, "actionable:capital_review": 2 }, receipt: { awaitingFinance: 2 } });
    const badges = Object.fromEntries(FINANCE.links.map((t) => [t.name, t.badge?.(c) ?? null]));
    expect(badges["Finance review"]).toEqual({ count: 5, color: "treehouseGreen", label: "5 items wait on you in Finance review" });
    expect(Object.values(badges).filter(Boolean)).toHaveLength(1);
    expect(FINANCE.links.map((t) => t.badge?.(released) ?? null).filter(Boolean)).toEqual([]);
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
