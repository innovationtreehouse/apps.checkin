import { visibleLinks } from "@/lib/nav/gates";
import { FINANCE_NAV_LINKS, REVENUE_OPS } from "@/lib/nav/sections/revenueOps";
import { sectionBadges, sectionTabBadge } from "@/components/navBadges";
import { LIBRARY_COUNT_PROVIDERS, collectLibraryCounts } from "../navLibraryCounts";
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

const hrefs = (tabs: readonly { href: string }[]) => tabs.map((t) => t.href);
const names = (tabs: readonly { name: string }[]) => tabs.map((t) => t.name);

describe("Revenue Ops Income and Shopify tabs", () => {
  it("shows both to FINANCE and Board", () => {
    for (const u of [finance, board]) {
      expect(names(visibleLinks(REVENUE_OPS, u, released))).toEqual(expect.arrayContaining(["Shopify", "Income"]));
    }
  });

  it("hides from sysadmin, a program lead and a plain member", () => {
    for (const u of [sysadmin, lead, member]) {
      expect(visibleLinks(REVENUE_OPS, u, released)).toEqual([]);
    }
  });

  it("puts Payouts and Reconciliation under Shopify, the rest under Income", () => {
    const tabs = visibleLinks(REVENUE_OPS, board, released);
    expect(hrefs(tabs.find((t) => t.name === "Shopify")?.subLinks ?? [])).toEqual([
      "/finance-ops/shopify-holds", "/finance-ops/payments", "/finance-ops/shopify-stock", "/income/payouts", "/income/reconciliation",
    ]);
    expect(hrefs(tabs.find((t) => t.name === "Income")?.subLinks ?? [])).toEqual(["/income/items", "/income/exclusions"]);
    expect(hrefs(tabs)).toEqual([...FINANCE_NAV_LINKS.map((l) => l.href), "/income/items"]);
  });

  it("gives FINANCE only the income screens under Shopify, after the payment-plan tabs", () => {
    const tabs = visibleLinks(REVENUE_OPS, finance, released);
    expect(hrefs(tabs.find((t) => t.name === "Shopify")?.subLinks ?? [])).toEqual(["/income/payouts", "/income/reconciliation"]);
    expect(hrefs(tabs).slice(0, 3)).toEqual(["/finance-ops/payment-plan", "/finance-ops/membership-payment-plan", "/income/payouts"]);
  });

  it("hides both from FINANCE until income is released", () => {
    const unreleased = counts(LIBRARY_KEYS.filter((k) => k !== "income"));
    expect(names(visibleLinks(REVENUE_OPS, finance, unreleased))).not.toEqual(expect.arrayContaining(["Shopify"]));
    expect(names(visibleLinks(REVENUE_OPS, finance, unreleased))).not.toEqual(expect.arrayContaining(["Income"]));
  });

  it("badges open reconciliation items on Reconciliation and Shopify, not Income, and once in the sidebar", () => {
    const c = counts([...LIBRARY_KEYS], { income: { openReconciliation: 3 } });
    const pill = { count: 3, color: "red", label: "3 open income reconciliation items" };
    const tabs = visibleLinks(REVENUE_OPS, finance, c);
    const shopify = tabs.find((t) => t.name === "Shopify");
    const income = tabs.find((t) => t.name === "Income");
    expect(sectionTabBadge(shopify?.subLinks ?? [], "/income/reconciliation", c)).toEqual(pill);
    expect(sectionTabBadge(tabs, shopify?.href ?? "", c)).toEqual(pill);
    expect(sectionTabBadge(tabs, income?.href ?? "", c)).toBeNull();
    expect(sectionBadges(REVENUE_OPS.href, tabs, c)).toEqual([{ ...pill, label: "3 open income reconciliation items" }]);
    expect(sectionTabBadge(tabs, shopify?.href ?? "", released)).toBeNull();
  });
});

describe("income count provider", () => {
  const provider = LIBRARY_COUNT_PROVIDERS.find((p) => p.library === "income");

  it("runs only for FINANCE, the one role that resolves reconciliation", () => {
    expect([finance, board, sysadmin, lead, member].map((u) => provider?.visible(u))).toEqual([
      true,
      false,
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

describe("Donations counts", () => {
  it("leave Revenue Ops for the Donations section", () => {
    expect(names(visibleLinks(REVENUE_OPS, finance, released))).not.toContain("Donations");
  });

  it("run the count provider only for FINANCE, the one role that manages donations", () => {
    const provider = LIBRARY_COUNT_PROVIDERS.find((p) => p.library === "bulk-donation");
    expect([finance, board, sysadmin, lead, member].map((u) => provider?.visible(u))).toEqual([true, false, false, false, false]);
  });
});

describe("Revenue Ops counts in the nav payload", () => {
  const providers = LIBRARY_COUNT_PROVIDERS.filter((p) => p.library === "income" || p.library === "bulk-donation");

  it("carries income and donation counts for FINANCE", async () => {
    expect(Object.keys((await collectLibraryCounts(finance, [...LIBRARY_KEYS], providers)) ?? {}).sort()).toEqual(["bulk-donation", "income"]);
  });

  it("carries none for Board, which still sees the Income and Shopify tabs", async () => {
    expect(await collectLibraryCounts(board, [...LIBRARY_KEYS], providers)).toBeUndefined();
    expect(names(visibleLinks(REVENUE_OPS, board, released))).toEqual(expect.arrayContaining(["Income", "Shopify"]));
  });
});
