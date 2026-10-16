import { INVENTORY_LIBRARY_TABS, visibleLibraryTabs } from "../libraryNav";
import { LIBRARY_COUNT_PROVIDERS } from "../navLibraryCounts";
import { inventoryAreaLinks } from "../catalogNav";
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

const manager: SessionUser = { id: 1, isInventoryManager: true };
const finance: SessionUser = { id: 2, isFinance: true };
const board: SessionUser = { id: 3, isBoardMember: true };
const member: SessionUser = { id: 4 };

const hrefs = (tabs: { href: string }[]) => tabs.map((t) => t.href);
const RECEIVING_TABS = INVENTORY_LIBRARY_TABS.filter((t) => t.href === "/inventory/receiving");

describe("Inventory Receiving tab", () => {
  it("shows to an inventory manager, FINANCE and Board", () => {
    for (const u of [manager, finance, board]) {
      expect(hrefs(visibleLibraryTabs(RECEIVING_TABS, u, released))).toEqual(["/inventory/receiving"]);
    }
  });

  it("hides from a plain member", () => {
    expect(visibleLibraryTabs(INVENTORY_LIBRARY_TABS, member, released)).toEqual([]);
  });

  it("hides from FINANCE until workflow-mapping is released", () => {
    const unreleased = counts(LIBRARY_KEYS.filter((k) => k !== "workflow-mapping"));
    expect(visibleLibraryTabs(RECEIVING_TABS, finance, unreleased)).toEqual([]);
  });

  it("admits FINANCE to the Inventory section with only Receiving when only workflow-mapping is released", () => {
    expect(hrefs(inventoryAreaLinks(finance, counts(["workflow-mapping"])))).toEqual(["/inventory/receiving"]);
  });

  it("badges the mapping and apply-failed queues", () => {
    const [tab] = visibleLibraryTabs(RECEIVING_TABS, manager, released);
    const c = counts([...LIBRARY_KEYS], { "workflow-mapping": { pending_review: 2, apply_failed: 1, applying: 5 } });
    expect(tab.badge?.(c)).toEqual({ count: 3, color: "red", label: "3 receipts awaiting mapping or apply" });
    expect(tab.badge?.(released)).toBeNull();
  });

  it("runs the workflow-mapping count provider only for the tab's audience", () => {
    const provider = LIBRARY_COUNT_PROVIDERS.find((p) => p.library === "workflow-mapping");
    expect([manager, finance, board, member].map((u) => provider?.visible(u))).toEqual([true, true, true, false]);
  });
});

describe("Inventory In-kind gifts tab", () => {
  const IN_KIND_TABS = INVENTORY_LIBRARY_TABS.filter((t) => t.href === "/inventory/in-kind");
  const operations: SessionUser = { id: 5, isOperations: true };

  it("shows to FINANCE, Board, operations and an inventory manager once bulk-donation is released", () => {
    for (const u of [finance, board, operations, manager]) {
      expect(hrefs(visibleLibraryTabs(IN_KIND_TABS, u, released))).toEqual(["/inventory/in-kind"]);
    }
  });

  it("hides from a plain member", () => {
    expect(visibleLibraryTabs(IN_KIND_TABS, member, released)).toEqual([]);
  });

  it("hides from operations until bulk-donation is released", () => {
    const unreleased = counts(LIBRARY_KEYS.filter((k) => k !== "bulk-donation"));
    expect(visibleLibraryTabs(IN_KIND_TABS, operations, unreleased)).toEqual([]);
  });
});
