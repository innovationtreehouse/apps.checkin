import { visibleLinks } from "@/lib/nav/gates";
import { INVENTORY } from "@/lib/nav/sections/inventory";
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

const manager: SessionUser = { id: 1, isInventoryManager: true };
const finance: SessionUser = { id: 2, isFinance: true };
const board: SessionUser = { id: 3, isBoardMember: true };
const member: SessionUser = { id: 4 };

const hrefs = (tabs: { href: string }[]) => tabs.map((t) => t.href);
const tabs = (u: SessionUser, c: TodoCounts) => hrefs(visibleLinks(INVENTORY, u, c));

describe("Inventory Part mapping tab", () => {
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

  it("admits FINANCE to the Inventory section with only Part mapping when only workflow-mapping is released", () => {
    expect(tabs(finance, counts(["workflow-mapping"]))).toEqual(["/inventory/receiving"]);
  });

  it("badges the mapping and apply-failed queues", () => {
    const tab = INVENTORY.links.find((l) => l.href === "/inventory/receiving");
    const c = counts([...LIBRARY_KEYS], { "workflow-mapping": { pending_review: 2, apply_failed: 1, applying: 5 } });
    expect(tab?.badge?.(c)).toEqual({ count: 3, color: "red", label: "3 receipts awaiting mapping or apply" });
    expect(tab?.badge?.(released)).toBeNull();
  });

  it("runs the workflow-mapping count provider only for an inventory manager, the one role that maps or applies", () => {
    const provider = LIBRARY_COUNT_PROVIDERS.find((p) => p.library === "workflow-mapping");
    expect([manager, finance, board, member].map((u) => provider?.visible(u))).toEqual([true, false, false, false]);
  });

  it("keeps the tab for FINANCE and Board while their nav payload carries no receiving count", async () => {
    const providers = LIBRARY_COUNT_PROVIDERS.filter((p) => p.library === "workflow-mapping");
    for (const u of [finance, board]) {
      expect(await collectLibraryCounts(u, [...LIBRARY_KEYS], providers)).toBeUndefined();
      expect(tabs(u, released)).toContain("/inventory/receiving");
    }
    expect(await collectLibraryCounts(manager, [...LIBRARY_KEYS], providers)).toEqual({ "workflow-mapping": {} });
  });
});

describe("Inventory Receive queue subtab", () => {
  const tab = () => INVENTORY.links.flatMap((l) => l.subLinks ?? []).find((l) => l.href === "/inventory/receive-queue");
  const subtabs = (u: SessionUser) => visibleLinks(INVENTORY, u, released).flatMap((l) => hrefs([...(l.subLinks ?? [])]));

  it("badges open backorders green", () => {
    const c = counts([...LIBRARY_KEYS], { "local-inventory": { openBackorders: 3 } });
    expect(tab()?.badge?.(c)).toEqual({ count: 3, color: "treehouseGreen", label: "3 backorders wait to be received" });
    const one = counts([...LIBRARY_KEYS], { "local-inventory": { openBackorders: 1 } });
    expect(tab()?.badge?.(one)?.label).toBe("1 backorder waits to be received");
    expect(tab()?.badge?.(released)).toBeNull();
  });

  it("shows to FINANCE and Board, but runs the count provider only for an inventory manager", () => {
    for (const u of [manager, finance, board]) expect(subtabs(u)).toContain("/inventory/receive-queue");
    const provider = LIBRARY_COUNT_PROVIDERS.find((p) => p.library === "local-inventory");
    expect([manager, finance, board, member].map((u) => provider?.visible(u))).toEqual([true, false, false, false]);
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
