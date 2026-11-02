/**
 * The Inventory section (/catalog, /inventory). The catalog and local-inventory
 * libraries own their screen lists; workflow-mapping owns Receiving. Catalog
 * and org inventory show to a catalog viewer, org inventory's manager-only
 * screens to an INVENTORY_MANAGER, its receiving screens to INVENTORY_MANAGER, FINANCE or BOARD, and the
 * receipt flow status page to an INVENTORY_MANAGER. A viewer any tab admits is
 * admitted to the section (FINANCE reaches Receiving).
 */
import { CATALOG_NAV_LINKS, CATALOG_TOP_NAV } from "@checkin/global-catalog/nav";
import { INVENTORY_NAV_LINKS, type InventoryNavLink } from "@checkin/local-inventory/nav";
import { RECEIVING_NAV } from "@checkin/workflow-mapping/nav";
import type { LibraryKey } from "@/lib/libraryRelease";
import type { RoleFlag } from "@/lib/roles";
import type { NavGate, NavSection, SubLink } from "@/lib/nav/types";
import { anyRole, firstVisibleHref, signedIn } from "@/lib/nav/gates";
import type { TodoCounts } from "@/lib/nav/todoCounts";
import { libraryCount, type NavBadge } from "@/components/navBadges";
import { RECEIPT_FLOW_LINK } from "@/lib/nav/sections/finance";
import { canSeeCatalog } from "@/lib/volunteer";

const catalogViewer: NavGate = (u) => canSeeCatalog(u);
const inventoryManager: NavGate = (u) => canSeeCatalog(u) && u?.isInventoryManager === true;

/** The workflow-mapping and inventory receiving read routes admit INVENTORY_MANAGER, FINANCE or BOARD. */
export const RECEIVING_ROLES: readonly RoleFlag[] = ["isInventoryManager", "isFinance", "isBoardMember"];

/** Green pill: open backorders waiting to be received. Its count reaches an INVENTORY_MANAGER alone. */
function openBackorders(c: TodoCounts | null): NavBadge | null {
  const n = libraryCount(c, "local-inventory", "openBackorders");
  return n > 0 ? { count: n, color: "treehouseGreen", label: `${n} ${n === 1 ? "backorder waits" : "backorders wait"} to be received` } : null;
}

/** Green pill: catalog proposals waiting for review. Its count reaches an INVENTORY_MANAGER alone. */
function pendingProposals(c: TodoCounts | null): NavBadge | null {
  const n = libraryCount(c, "catalog", "pendingProvisionalItems") + libraryCount(c, "catalog", "pendingItemReferences");
  return n > 0 ? { count: n, color: "treehouseGreen", label: `${n} catalog ${n === 1 ? "proposal" : "proposals"} to review` } : null;
}

/** A green pill for one INVENTORY_MANAGER-only count; absent at zero. */
function managerQueue(key: string, label: (n: number) => string, lib: LibraryKey): (c: TodoCounts | null) => NavBadge | null {
  return (c) => {
    const n = libraryCount(c, lib, key);
    return n > 0 ? { count: n, color: "treehouseGreen", label: label(n) } : null;
  };
}

const CATALOG_SUB_BADGES: Record<string, (c: TodoCounts | null) => NavBadge | null> = {
  "/catalog/items": managerQueue("unresolvedConflicts", (n) => `${n} reference ${n === 1 ? "conflict" : "conflicts"} to resolve`, "catalog"),
  "/catalog/proposals": pendingProposals,
  "/catalog/conversion-challenges": managerQueue("pendingChallenges", (n) => `${n} conversion ${n === 1 ? "challenge" : "challenges"} to review`, "catalog"),
};

/** An org-inventory screen as a section link, gated by its manager-only or receiving flag. */
function inventoryLink({ managerOnly, receiving, ...l }: Omit<InventoryNavLink, "subLinks">): SubLink {
  return {
    ...l,
    library: "local-inventory",
    visible: managerOnly ? inventoryManager : receiving ? anyRole(RECEIVING_ROLES) : catalogViewer,
    ...(l.href === "/inventory/receive-queue" ? { badge: openBackorders } : {}),
    ...(l.href === "/inventory/unlocated"
      ? { badge: managerQueue("unlocated", (n) => `${n} ${n === 1 ? "item needs" : "items need"} a location`, "local-inventory") }
      : {}),
    ...(l.href === "/inventory/merge-conflicts"
      ? { badge: managerQueue("pendingMergeConflicts", (n) => `${n} merge ${n === 1 ? "conflict" : "conflicts"} to resolve`, "local-inventory") }
      : {}),
  };
}

export const INVENTORY: NavSection = {
  id: "inventory",
  label: CATALOG_TOP_NAV.label,
  href: CATALOG_TOP_NAV.href,
  links: [
    ...CATALOG_NAV_LINKS.map((l) => ({
      ...l,
      library: "catalog" as const,
      visible: catalogViewer,
      subLinks: l.subLinks?.map((s) => ({ ...s, badge: CATALOG_SUB_BADGES[s.href] })),
    })),
    ...INVENTORY_NAV_LINKS.map(({ subLinks, ...l }) =>
      subLinks ? { ...inventoryLink(l), subLinks: subLinks.map(inventoryLink) } : inventoryLink(l)),
    {
      ...RECEIVING_NAV,
      library: "workflow-mapping",
      visible: anyRole(RECEIVING_ROLES),
      badge: (c) => {
        const failed = libraryCount(c, "workflow-mapping", "apply_failed");
        const n = libraryCount(c, "workflow-mapping", "pending_review") + failed;
        return n > 0
          ? { count: n, color: failed > 0 ? "red" : "treehouseGreen", label: `${n} ${n === 1 ? "receipt" : "receipts"} awaiting mapping or apply` }
          : null;
      },
    },
    // FINANCE and BOARD reach the flow status page from Finance.
    { ...RECEIPT_FLOW_LINK, library: "workflow-mapping", visible: inventoryManager },
  ],
  visible: signedIn,
  hrefFor: (u, c) => firstVisibleHref(INVENTORY, u, c),
};
