import { visibleLinks } from "@/lib/nav/gates";
import { INVENTORY } from "@/lib/nav/sections/inventory";
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

const manager: SessionUser = { id: 1, isInventoryManager: true };
const finance: SessionUser = { id: 2, isFinance: true };
const board: SessionUser = { id: 3, isBoardMember: true };
const member: SessionUser = { id: 4 };

const hrefs = (tabs: { href: string }[]) => tabs.map((t) => t.href);
const tabs = (u: SessionUser, c: TodoCounts) => hrefs(visibleLinks(INVENTORY, u, c));

describe("Inventory Receiving tab", () => {
  it("shows to an inventory manager, FINANCE and Board", () => {
    for (const u of [manager, finance, board]) {
      expect(tabs(u, released)).toContain("/inventory/receiving");
    }
  });

  it("hides from a plain member", () => {
    expect(tabs(member, released)).toEqual([]);
  });

  it("hides from FINANCE until workflow-mapping is released", () => {
    const unreleased = counts(LIBRARY_KEYS.filter((k) => k !== "workflow-mapping"));
    expect(tabs(finance, unreleased)).not.toContain("/inventory/receiving");
  });

  it("admits FINANCE to the Inventory section with only Receiving when only workflow-mapping is released", () => {
    expect(tabs(finance, counts(["workflow-mapping"]))).toEqual(["/inventory/receiving"]);
  });

  it("badges the mapping and apply-failed queues", () => {
    const tab = INVENTORY.links.find((l) => l.href === "/inventory/receiving");
    const c = counts([...LIBRARY_KEYS], { "workflow-mapping": { pending_review: 2, apply_failed: 1, applying: 5 } });
    expect(tab?.badge?.(c)).toEqual({ count: 3, color: "red", label: "3 receipts awaiting mapping or apply" });
    expect(tab?.badge?.(released)).toBeNull();
  });

  it("runs the workflow-mapping count provider only for the tab's audience", () => {
    const provider = LIBRARY_COUNT_PROVIDERS.find((p) => p.library === "workflow-mapping");
    expect([manager, finance, board, member].map((u) => provider?.visible(u))).toEqual([true, true, true, false]);
  });
});

describe("Inventory In-kind gifts tab", () => {
  const operations: SessionUser = { id: 5, isOperations: true };

  it("shows to FINANCE, Board, operations and an inventory manager once bulk-donation is released", () => {
    for (const u of [finance, board, operations, manager]) {
      expect(tabs(u, released)).toContain("/inventory/in-kind");
    }
  });

  it("hides from a plain member", () => {
    expect(tabs(member, released)).not.toContain("/inventory/in-kind");
  });

  it("hides from operations until bulk-donation is released", () => {
    const unreleased = counts(LIBRARY_KEYS.filter((k) => k !== "bulk-donation"));
    expect(tabs(operations, unreleased)).not.toContain("/inventory/in-kind");
  });
});
