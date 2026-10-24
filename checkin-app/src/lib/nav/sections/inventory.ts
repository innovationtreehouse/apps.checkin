/**
 * The Inventory section (/catalog, /inventory). The catalog and local-inventory
 * libraries own their screen lists; workflow-mapping owns Receiving and bulk
 * donation the in-kind screen. Catalog and org inventory show to a catalog
 * viewer, org inventory's manager-only screens to an INVENTORY_MANAGER, its
 * receiving screens to INVENTORY_MANAGER, FINANCE or BOARD (#2384). A
 * viewer any tab admits is admitted to the section (FINANCE reaches Receiving).
 */
import { CATALOG_NAV_LINKS, CATALOG_TOP_NAV } from "@checkin/global-catalog/nav";
import { INVENTORY_NAV_LINKS, type InventoryNavLink } from "@checkin/local-inventory/nav";
import { RECEIVING_NAV } from "@checkin/workflow-mapping/nav";
import { IN_KIND_TAB } from "@checkin/bulk-donation/nav";
import type { RoleFlag } from "@/lib/roles";
import type { NavGate, NavSection, SubLink } from "@/lib/nav/types";
import { anyRole, firstVisibleHref, signedIn } from "@/lib/nav/gates";
import { libraryCount } from "@/components/navBadges";
import { canSeeCatalog } from "@/lib/volunteer";

const catalogViewer: NavGate = (u) => canSeeCatalog(u);
const inventoryManager: NavGate = (u) => canSeeCatalog(u) && u?.isInventoryManager === true;

/** The workflow-mapping and inventory receiving read routes admit INVENTORY_MANAGER, FINANCE or BOARD. */
export const RECEIVING_ROLES: readonly RoleFlag[] = ["isInventoryManager", "isFinance", "isBoardMember"];
/** The no-receipt in-kind list route admits FINANCE, BOARD, OPERATIONS or INVENTORY_MANAGER. */
export const IN_KIND_ROLES: readonly RoleFlag[] = ["isFinance", "isBoardMember", "isOperations", "isInventoryManager"];

/** An org-inventory screen as a section link, gated by its manager-only or receiving flag. */
function inventoryLink({ managerOnly, receiving, ...l }: Omit<InventoryNavLink, "subLinks">): SubLink {
  return {
    ...l,
    library: "local-inventory",
    visible: managerOnly ? inventoryManager : receiving ? anyRole(RECEIVING_ROLES) : catalogViewer,
  };
}

export const INVENTORY: NavSection = {
  id: "inventory",
  label: CATALOG_TOP_NAV.label,
  href: CATALOG_TOP_NAV.href,
  links: [
    ...CATALOG_NAV_LINKS.map((l) => ({ ...l, library: "catalog" as const, visible: catalogViewer })),
    ...INVENTORY_NAV_LINKS.map(({ subLinks, ...l }) =>
      subLinks ? { ...inventoryLink(l), subLinks: subLinks.map(inventoryLink) } : inventoryLink(l)),
    {
      ...RECEIVING_NAV,
      library: "workflow-mapping",
      visible: anyRole(RECEIVING_ROLES),
      badge: (c) => {
        const n = libraryCount(c, "workflow-mapping", "pending_review") + libraryCount(c, "workflow-mapping", "apply_failed");
        return n > 0 ? { count: n, color: "red", label: `${n} receipts awaiting mapping or apply` } : null;
      },
    },
    { ...IN_KIND_TAB, library: "bulk-donation", visible: anyRole(IN_KIND_ROLES) },
  ],
  visible: signedIn,
  hrefFor: (u, c) => firstVisibleHref(INVENTORY, u, c),
};
