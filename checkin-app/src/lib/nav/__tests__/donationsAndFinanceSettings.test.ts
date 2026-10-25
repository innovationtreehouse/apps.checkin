import nextConfig from "../../../../next.config";
import { LIBRARY_KEYS } from "@/lib/libraryRelease";
import type { TodoCounts } from "@/lib/nav/todoCounts";
import type { NavUser } from "@/lib/nav/types";
import { sectionShown, visibleLinks } from "@/lib/nav/gates";
import { DONATIONS, donationsRolesFor } from "@/lib/nav/sections/donations";
import { SETTINGS, settingsRolesFor } from "@/lib/nav/sections/settings";
import { FINANCE } from "@/lib/nav/sections/finance";
import { INVENTORY } from "@/lib/nav/sections/inventory";
import { REVENUE_OPS } from "@/lib/nav/sections/revenueOps";
import { sectionBadges } from "@/components/navBadges";

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

const finance: NavUser = { isFinance: true };
const board: NavUser = { isBoardMember: true };
const sysadmin: NavUser = { isSysadmin: true };
const operations: NavUser = { isOperations: true };
const inventoryManager: NavUser = { isInventoryManager: true };
const keyholder: NavUser = { isKeyholder: true };

const hrefs = (s: typeof DONATIONS, u: NavUser, c: TodoCounts | null = released) => visibleLinks(s, u, c).map((l) => l.href);

const DONATION_SCREENS = [
  "/donations/uploads", "/donations/unassigned", "/donations/transactions", "/donations/holds", "/donations/in-kind",
  "/donations/events", "/donations/qb-queue", "/donations/comment-rules", "/donations/account-map", "/donations/qb-exclusions",
];

describe("Settings > Finance", () => {
  it("shows Finance to FINANCE and Board, last, at /settings/finance", () => {
    expect(hrefs(SETTINGS, finance)).toEqual(["/settings/finance"]);
    expect(hrefs(SETTINGS, board).at(-1)).toBe("/settings/finance");
    expect(visibleLinks(SETTINGS, finance, released)[0].name).toBe("Finance");
  });

  it("hides Finance from sysadmin and operations, who never reached expense settings", () => {
    expect(hrefs(SETTINGS, sysadmin)).not.toContain("/settings/finance");
    expect(hrefs(SETTINGS, operations)).toEqual(["/settings/outreach"]);
  });

  it("hides Finance from FINANCE until expense is released", () => {
    const unreleased = counts(LIBRARY_KEYS.filter((k) => k !== "expense"));
    expect(sectionShown(SETTINGS, finance, unreleased)).toBe(false);
  });

  it("sends FINANCE's sidebar entry straight to Finance", () => {
    expect(SETTINGS.hrefFor?.(finance, released)).toBe("/settings/finance");
    expect(SETTINGS.hrefFor?.(board, released)).toBe("/settings/membership");
  });

  it("admits FINANCE or Board on Finance, and the old Settings roles everywhere else", () => {
    expect(settingsRolesFor("/settings/finance")).toEqual(["isFinance", "isBoardMember"]);
    expect(settingsRolesFor("/settings/membership")).toEqual(["isSysadmin", "isBoardMember", "isOperations"]);
    expect(settingsRolesFor("/settings")).toEqual(["isSysadmin", "isBoardMember", "isOperations"]);
  });

  it("leaves the Finance section", () => {
    const financeHrefs = FINANCE.links.flatMap((l) => [l.href, ...(l.subLinks ?? []).map((s) => s.href)]);
    expect(financeHrefs).not.toContain("/expense/settings");
    expect(financeHrefs).not.toContain("/settings/finance");
  });
});

describe("Donations section", () => {
  it("shows FINANCE and Board every donation screen, then In-kind gifts", () => {
    for (const u of [finance, board]) expect(hrefs(DONATIONS, u)).toEqual([...DONATION_SCREENS, "/donations/in-kind-gifts"]);
  });

  it("shows operations and an inventory manager only In-kind gifts, and lands them there", () => {
    for (const u of [operations, inventoryManager]) {
      expect(hrefs(DONATIONS, u)).toEqual(["/donations/in-kind-gifts"]);
      expect(DONATIONS.hrefFor?.(u, released)).toBe("/donations/in-kind-gifts");
    }
  });

  it("hides from sysadmin and a keyholder", () => {
    for (const u of [sysadmin, keyholder]) expect(sectionShown(DONATIONS, u, released)).toBe(false);
  });

  it("hides until bulk-donation is released", () => {
    const unreleased = counts(LIBRARY_KEYS.filter((k) => k !== "bulk-donation"));
    for (const u of [finance, operations]) expect(sectionShown(DONATIONS, u, unreleased)).toBe(false);
  });

  it("admits FINANCE or Board on the donation screens, and the in-kind audience on In-kind gifts", () => {
    expect(donationsRolesFor("/donations/uploads")).toEqual(["isFinance", "isBoardMember"]);
    expect(donationsRolesFor("/donations/in-kind")).toEqual(["isFinance", "isBoardMember"]);
    expect(donationsRolesFor("/donations/in-kind-gifts")).toEqual(["isFinance", "isBoardMember", "isOperations", "isInventoryManager"]);
  });

  it("carries the unassigned and holds counts as one red sidebar pill, and each on its own tab", () => {
    const c = counts([...LIBRARY_KEYS], { "bulk-donation": { unassignedQueue: 2, disbursementHolds: 1 } });
    const tabs = visibleLinks(DONATIONS, finance, c);
    expect(sectionBadges(DONATIONS.href, tabs, c)).toEqual([
      { count: 3, color: "red", label: "2 unassigned gifts; 1 disbursement holds" },
    ]);
    expect(tabs.find((t) => t.href === "/donations/unassigned")?.badge?.(c)?.count).toBe(2);
    expect(tabs.find((t) => t.href === "/donations/holds")?.badge?.(c)?.count).toBe(1);
    expect(sectionBadges(DONATIONS.href, tabs, released)).toEqual([]);
  });

  it("leaves Revenue Ops and Inventory", () => {
    expect(REVENUE_OPS.links.map((l) => l.href)).not.toContain("/donations");
    expect(INVENTORY.links.map((l) => l.href)).not.toContain("/inventory/in-kind");
  });
});

describe("old paths", () => {
  it("redirect to the moved pages", async () => {
    const redirects = (await nextConfig.redirects?.()) ?? [];
    expect(redirects).toEqual(expect.arrayContaining([
      { source: "/expense/settings", destination: "/settings/finance", permanent: true },
      { source: "/inventory/in-kind", destination: "/donations/in-kind-gifts", permanent: true },
    ]));
  });
});
