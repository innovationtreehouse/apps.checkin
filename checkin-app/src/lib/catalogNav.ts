import { isTreehouseVolunteer } from "@/lib/volunteer";
/**
 * Placement of the Inventory section nav in checkin (#1286 §7, #1287 §7). The
 * catalog and local-inventory libraries own their screen lists (their `/nav`
 * exports); this file supplies checkin's viewer predicate and the combined
 * section tabs the `/catalog` and `/inventory` layouts render. checkin owns
 * ordering (AppFrame) and the top-level icon; the libraries dictate neither.
 */
import type { SessionUser } from "@/types/auth";
import type { NavLink } from "@/lib/nav/types";
import { CATALOG_NAV_LINKS, CATALOG_TOP_NAV } from "@inventory/global-catalog/nav";
import { INVENTORY_NAV_LINKS } from "@inventory/local-inventory/nav";

export { CATALOG_TOP_NAV };

/**
 * The Inventory section's tabs: the catalog's screens, then org inventory's
 * (#1287 §7). Org inventory's manager-only screens show only to an
 * INVENTORY_MANAGER, matching their routes' gate.
 */
export function inventoryAreaLinks(user: SessionUser | undefined): NavLink[] {
  const inventory = INVENTORY_NAV_LINKS.filter((l) => !l.managerOnly || !!user?.isInventoryManager);
  return [...CATALOG_NAV_LINKS, ...inventory].map(({ name, href, icon }) => ({ name, href, icon }));
}

/**
 * Client mirror of the server `catalog-viewer` gate (§6): the shared Treehouse
 * Volunteer definition, read from session claims so the nav admits exactly the
 * audience the server does.
 */
export function isCatalogViewerClient(user: SessionUser | undefined): boolean {
  return isTreehouseVolunteer(user);
}
