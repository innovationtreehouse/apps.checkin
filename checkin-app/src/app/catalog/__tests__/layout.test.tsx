jest.mock("next/navigation", () => jest.requireActual("@/test-helpers/rtl").navMock());
jest.mock("next-auth/react", () => jest.requireActual("@/test-helpers/rtl").authMock());
jest.mock("@/hooks/useTodoCounts", () => ({ useTodoCounts: jest.fn(() => null) }));

import { screen } from "@testing-library/react";
import { renderWithProviders, setSession, setPathname, resetRtl, router } from "@/test-helpers/rtl";
import { useTodoCounts } from "@/hooks/useTodoCounts";
import { LIBRARY_KEYS } from "@/lib/libraryRelease";
import type { TodoCounts } from "@/lib/nav/todoCounts";
import { sectionBadges, sectionTabBadge } from "@/components/navBadges";
import { INVENTORY } from "@/lib/nav/sections/inventory";
import { visibleLinks } from "@/lib/nav/gates";
import type { NavUser } from "@/lib/nav/types";
import CatalogLayout from "../layout";

const counts: TodoCounts = {
  member: { household: [], programs: [], programsAwaitingFinance: 0 },
  building: 0,
  buildingHousehold: 0,
  buildingReachable: true,
  activePrograms: 0,
  releasedLibraries: [...LIBRARY_KEYS],
};

beforeEach(() => {
  resetRtl();
  (useTodoCounts as jest.Mock).mockReturnValue(counts);
});

const board: NavUser = { isBoardMember: true };
const INVENTORY_TABS = (u: NavUser) => visibleLinks(INVENTORY, u, counts);
const renderLayout = () => renderWithProviders(<CatalogLayout><div>PAGE</div></CatalogLayout>);

describe("catalog layout gate", () => {
  it("turns away an adult with no role or volunteer input", () => {
    setSession({ id: 1, ageBand: "adult" });
    renderLayout();
    expect(screen.queryByText("PAGE")).not.toBeInTheDocument();
    expect(router.push).toHaveBeenCalledWith("/");
  });

  it("admits an active youth program volunteer", () => {
    setSession({ id: 2, ageBand: "youth", isProgramVolunteer: true, isActiveOrgMember: true });
    renderLayout();
    expect(screen.getByText("PAGE")).toBeInTheDocument();
    expect(router.push).not.toHaveBeenCalled();
  });
});

const tabNames = () => screen.getAllByRole("tab").map((t) => (t.textContent ?? "").replace(/^[^A-Za-z]+/, "").replace(/\d+$/, ""));
/** The second tab row's names: the tabs after the last top-level tab. */
const subtabNames = (top: string[]) => tabNames().slice(top.length);

describe("catalog layout tabs", () => {
  it("lays out Global Catalog's subtabs for an inventory manager, in order", () => {
    setSession({ id: 4, isInventoryManager: true });
    setPathname("/catalog/categories");
    renderLayout();
    expect(screen.getByRole("tab", { name: /Global Catalog/ })).toHaveAttribute("aria-selected", "true");
    expect(subtabNames(["Global Catalog", "Org Inventory", "Diagnostics", "Part mapping"])).toEqual([
      "Items", "Categories", "Learned References", "Provisional Items", "Item Reference Proposals", "Reference Conflicts", "Conversion Challenges",
    ]);
    expect(screen.getByRole("tab", { name: /Categories/ })).toHaveAttribute("aria-selected", "true");
  });

  it("hides the manager-only Learned References and Reference Conflicts from Board", () => {
    setSession({ id: 3, isBoardMember: true });
    setPathname("/catalog/items");
    renderLayout();
    expect(subtabNames(["Global Catalog", "Org Inventory", "Diagnostics", "Part mapping"])).toEqual([
      "Items", "Categories", "Provisional Items", "Item Reference Proposals", "Conversion Challenges",
    ]);
  });

  it.each([
    ["/catalog/learned-references", /Learned References/],
    ["/catalog/provisional-items", /Provisional Items/],
    ["/catalog/item-reference-proposals", /Item Reference Proposals/],
    ["/catalog/reference-conflicts", /Reference Conflicts/],
  ])("selects Global Catalog and its subtab on %s", (path, name) => {
    setSession({ id: 4, isInventoryManager: true });
    setPathname(path);
    renderLayout();
    expect(screen.getByRole("tab", { name: /Global Catalog/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name })).toHaveAttribute("aria-selected", "true");
  });

  it("has no Flow status tab: the flow status page lives in Finance", () => {
    setSession({ id: 4, isInventoryManager: true });
    setPathname("/catalog/items");
    renderLayout();
    expect(screen.queryByRole("tab", { name: /Flow status/i })).not.toBeInTheDocument();
  });

  it("groups Locations under Org Inventory", () => {
    setSession({ id: 3, isBoardMember: true });
    setPathname("/inventory/locations");
    renderLayout();
    expect(screen.getByRole("tab", { name: /Org Inventory/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: /Locations/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("tab", { name: /Categories/ })).not.toBeInTheDocument();
  });

  it("hides the sub-row on a tab without sub-pages", () => {
    setSession({ id: 4, isInventoryManager: true });
    setPathname("/inventory/receiving");
    renderLayout();
    expect(screen.queryByRole("tab", { name: /Categories/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /Locations/ })).not.toBeInTheDocument();
  });
});

describe("org inventory subtabs", () => {
  const TOP = ["Global Catalog", "Org Inventory", "Diagnostics", "Part mapping"];

  it("lays out one row for an inventory manager: All inventory, Needs a location, Receive queue, Locations, Provisional Map", () => {
    setSession({ id: 4, isInventoryManager: true });
    setPathname("/inventory/org-items");
    renderLayout();
    expect(subtabNames(TOP)).toEqual(["All inventory", "Needs a location", "Receive queue", "Locations", "Provisional Map"]);
    expect(screen.getByRole("tab", { name: /All inventory/ })).toHaveAttribute("aria-selected", "true");
  });

  it("hides the manager-only Needs a location and Provisional Map from Board", () => {
    setSession({ id: 3, isBoardMember: true });
    setPathname("/inventory/org-items");
    renderLayout();
    expect(subtabNames(TOP)).toEqual(["All inventory", "Receive queue", "Locations"]);
  });

  it("shows a catalog viewer without a receiving role only All inventory and Locations", () => {
    setSession({ id: 2, ageBand: "youth", isProgramVolunteer: true, isActiveOrgMember: true });
    setPathname("/inventory/org-items");
    renderLayout();
    expect(subtabNames(["Global Catalog", "Org Inventory"])).toEqual(["All inventory", "Locations"]);
  });

  it.each([
    ["/inventory/receive-queue", /Receive queue/],
    ["/inventory/unlocated", /Needs a location/],
    ["/inventory/provisional-items", /Provisional Map/],
  ])("selects Org Inventory and its subtab on %s", (path, name) => {
    setSession({ id: 4, isInventoryManager: true });
    setPathname(path);
    renderLayout();
    expect(screen.getByRole("tab", { name: /Org Inventory/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name })).toHaveAttribute("aria-selected", "true");
  });

  it("has no top-level Receive queue tab and no Items subtab", () => {
    setSession({ id: 4, isInventoryManager: true });
    setPathname("/inventory/merge-conflicts");
    renderLayout();
    expect(screen.queryByRole("tab", { name: /Receive queue/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /^Items$/ })).not.toBeInTheDocument();
  });

  it("has no Applied Deltas tab: its applies live in the Inventory log", () => {
    setSession({ id: 4, isInventoryManager: true });
    setPathname("/inventory/inventory-log");
    renderLayout();
    expect(screen.queryByRole("tab", { name: /Applied Deltas/i })).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Inventory log/ })).toHaveAttribute("aria-selected", "true");
  });
});

describe("diagnostics subtabs", () => {
  const TOP = ["Global Catalog", "Org Inventory", "Diagnostics", "Part mapping"];

  it("lays out Merge Conflicts, Org Events and Inventory log for an inventory manager", () => {
    setSession({ id: 4, isInventoryManager: true });
    setPathname("/inventory/merge-conflicts");
    renderLayout();
    expect(screen.getByRole("tab", { name: /Diagnostics/ })).toHaveAttribute("aria-selected", "true");
    expect(subtabNames(TOP)).toEqual(["Merge Conflicts", "Org Events", "Inventory log"]);
  });

  it.each([
    ["/inventory/org-events", /Org Events/],
    ["/inventory/inventory-log", /Inventory log/],
  ])("selects Diagnostics and its subtab on %s", (path, name) => {
    setSession({ id: 4, isInventoryManager: true });
    setPathname(path);
    renderLayout();
    expect(screen.getByRole("tab", { name: /Diagnostics/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name })).toHaveAttribute("aria-selected", "true");
  });

  it("shows Board only the Inventory log, and opens Diagnostics on it", () => {
    setSession({ id: 3, isBoardMember: true });
    setPathname("/inventory/inventory-log");
    renderLayout();
    expect(subtabNames(TOP)).toEqual(["Inventory log"]);
    expect(INVENTORY_TABS(board).find((l) => l.name === "Diagnostics")?.href).toBe("/inventory/inventory-log");
  });

  it("hides Diagnostics from a catalog viewer without a receiving role", () => {
    setSession({ id: 2, ageBand: "youth", isProgramVolunteer: true, isActiveOrgMember: true });
    setPathname("/inventory/org-items");
    renderLayout();
    expect(screen.queryByRole("tab", { name: /Diagnostics/ })).not.toBeInTheDocument();
  });
});

describe("part mapping tab", () => {
  it("names the receipt-mapping queue Part mapping, not Receiving", () => {
    setSession({ id: 4, isInventoryManager: true });
    setPathname("/inventory/receiving");
    renderLayout();
    expect(screen.getByRole("tab", { name: /Part mapping/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("tab", { name: /^Receiving/ })).not.toBeInTheDocument();
  });
});

describe("catalog layout queue pills", () => {
  const withPending = (catalog?: Record<string, number>) =>
    (useTodoCounts as jest.Mock).mockReturnValue({ ...counts, libraries: catalog ? { catalog } : undefined });

  it("puts each proposal queue's count on its own subtab, and their total on Global Catalog", () => {
    withPending({ pendingProvisionalItems: 3, pendingItemReferences: 2 });
    setSession({ id: 4, isInventoryManager: true });
    setPathname("/catalog/provisional-items");
    renderLayout();
    expect(screen.getByRole("tab", { name: /Provisional Items/ })).toContainElement(screen.getByLabelText("3 provisional items to review"));
    expect(screen.getByRole("tab", { name: /Item Reference Proposals/ })).toContainElement(screen.getByLabelText("2 item reference proposals to review"));
    expect(screen.getByRole("tab", { name: /Global Catalog/ })).toHaveTextContent("5");
  });

  it("puts the reference conflict count on Reference Conflicts, not on Items", () => {
    withPending({ unresolvedConflicts: 2 });
    setSession({ id: 4, isInventoryManager: true });
    setPathname("/catalog/items");
    renderLayout();
    const [top, sub] = screen.getAllByLabelText("2 reference conflicts to resolve");
    expect(screen.getByRole("tab", { name: /Global Catalog/ })).toContainElement(top);
    expect(screen.getByRole("tab", { name: /Reference Conflicts/ })).toContainElement(sub);
    expect(screen.getByRole("tab", { name: /^\W*Items/ })).not.toHaveTextContent("2");
  });

  it("shows no pill when the counts are absent, as for a viewer who cannot act or a failed read", () => {
    withPending();
    setSession({ id: 3, isBoardMember: true });
    setPathname("/catalog/item-reference-proposals");
    renderLayout();
    expect(screen.queryByLabelText(/to review/)).not.toBeInTheDocument();
  });

  it("counts each queue once: sub-tabs alone carry a badge, and the sidebar sums them", () => {
    const withAll = { ...counts, libraries: { catalog: { pendingProvisionalItems: 3, pendingItemReferences: 2, unresolvedConflicts: 1, pendingChallenges: 4 } } };
    const catalogTabs = INVENTORY.links.filter((l) => l.library === "catalog");
    expect(sectionTabBadge(catalogTabs, "/catalog/items", withAll)?.count).toBe(10);
    expect(sectionBadges("/catalog", catalogTabs, withAll).map((b) => b.count)).toEqual([10]);
    const subs = catalogTabs[0].subLinks ?? [];
    expect(sectionTabBadge(subs, "/catalog/items", withAll)).toBeNull();
    expect(sectionTabBadge(subs, "/catalog/provisional-items", withAll)?.count).toBe(3);
    expect(sectionTabBadge(subs, "/catalog/item-reference-proposals", withAll)?.count).toBe(2);
    expect(sectionTabBadge(subs, "/catalog/reference-conflicts", withAll)?.count).toBe(1);
    expect(sectionTabBadge(subs, "/catalog/conversion-challenges", withAll)?.count).toBe(4);
  });

  it("carries the merge conflict count on the Merge Conflicts subtab and on Diagnostics", () => {
    const c = { ...counts, libraries: { "local-inventory": { pendingMergeConflicts: 2 } } };
    const diagnostics = INVENTORY.links.find((l) => l.name === "Diagnostics");
    expect(diagnostics && sectionTabBadge([diagnostics], diagnostics.href, c)?.count).toBe(2);
    expect(sectionTabBadge(diagnostics?.subLinks ?? [], "/inventory/merge-conflicts", c)?.label).toBe("2 merge conflicts to resolve");
  });
});
