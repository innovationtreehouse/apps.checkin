import { FINANCE_NAV_LINKS, revenueOpsTabs } from "../financeNav";
import { LIBRARY_KEYS } from "@/lib/libraryRelease";
import type { TodoCounts } from "@/lib/nav/todoCounts";

describe("FINANCE_NAV_LINKS", () => {
  it("is a non-empty list of nav links with name, href, and icon", () => {
    expect(FINANCE_NAV_LINKS.length).toBeGreaterThan(0);
    for (const link of FINANCE_NAV_LINKS) {
      expect(typeof link.name).toBe("string");
      expect(link.href.startsWith("/finance-ops/")).toBe(true);
      expect(typeof link.icon).toBe("string");
    }
  });

  it("has unique hrefs", () => {
    const hrefs = FINANCE_NAV_LINKS.map((l) => l.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });
});

describe("Revenue Ops Donations tab", () => {
  const counts = {
    member: { household: [], programs: [], programsAwaitingFinance: 0 },
    building: 0,
    buildingHousehold: 0,
    buildingReachable: true,
    activePrograms: 0,
    releasedLibraries: [...LIBRARY_KEYS],
    libraries: { "bulk-donation": { unassignedQueue: 2, disbursementHolds: 1 } },
  } as TodoCounts;

  it("shows FINANCE the Donations tab once bulk-donation is released, with unassigned + holds as its pill", () => {
    const tab = revenueOpsTabs({ id: 1, isFinance: true }, counts).find((t) => t.name === "Donations");
    expect(tab?.href).toBe("/donations");
    expect(tab?.badge?.(counts)?.count).toBe(3);
  });

  it("hides it from a non-finance user", () => {
    expect(revenueOpsTabs({ id: 2, isKeyholder: true }, counts)).toEqual([]);
  });
});
