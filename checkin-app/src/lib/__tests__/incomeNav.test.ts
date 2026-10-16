import { REVENUE_OPS_LIBRARY_TABS, visibleLibraryTabs } from "../libraryNav";
import { revenueOpsTabs, FINANCE_NAV_LINKS } from "../financeNav";
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

const finance: SessionUser = { id: 1, isFinance: true };
const board: SessionUser = { id: 2, isBoardMember: true };
const sysadmin: SessionUser = { id: 3, isSysadmin: true };
const lead: SessionUser = { id: 4, programsLed: [9] };
const member: SessionUser = { id: 5 };

const hrefs = (tabs: { href: string }[]) => tabs.map((t) => t.href);

describe("Revenue Ops Income tab", () => {
  it("shows to FINANCE and Board", () => {
    for (const u of [finance, board]) {
      expect(hrefs(visibleLibraryTabs(REVENUE_OPS_LIBRARY_TABS, u, released))).toContain("/income");
    }
  });

  it("hides from sysadmin, a program lead and a plain member", () => {
    for (const u of [sysadmin, lead, member]) {
      expect(revenueOpsTabs(u, released)).toEqual([]);
    }
  });

  it("sits after the Board-only legacy tabs; FINANCE lands on it", () => {
    expect(hrefs(revenueOpsTabs(board, released))).toEqual([...FINANCE_NAV_LINKS.map((l) => l.href), "/income", "/donations"]);
    expect(hrefs(revenueOpsTabs(finance, released))[0]).toBe("/income");
  });

  it("hides from FINANCE until income is released", () => {
    const unreleased = counts(LIBRARY_KEYS.filter((k) => k !== "income"));
    expect(hrefs(revenueOpsTabs(finance, unreleased))).not.toContain("/income");
  });

  it("badges open reconciliation items", () => {
    const income = REVENUE_OPS_LIBRARY_TABS.find((t) => t.href === "/income");
    const c = counts([...LIBRARY_KEYS], { income: { openReconciliation: 3 } });
    expect(income?.badge?.(c)).toEqual({ count: 3, color: "red", label: "3 open income reconciliation items" });
    expect(income?.badge?.(released)).toBeNull();
  });
});

describe("income count provider", () => {
  const provider = LIBRARY_COUNT_PROVIDERS.find((p) => p.library === "income");

  it("runs only for the tab's audience", () => {
    expect([finance, board, sysadmin, lead, member].map((u) => provider?.visible(u))).toEqual([
      true,
      true,
      false,
      false,
      false,
    ]);
  });

  it("contributes no counts when the income database is not configured", async () => {
    const saved = process.env.INCOME_DATABASE_URL;
    delete process.env.INCOME_DATABASE_URL;
    try {
      expect(await provider?.count(finance)).toEqual({});
    } finally {
      if (saved !== undefined) process.env.INCOME_DATABASE_URL = saved;
    }
  });
});
