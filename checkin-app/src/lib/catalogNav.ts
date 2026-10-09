/**
 * Placement of the Inventory section nav in checkin (#1286 §7, #1287 §7). The
 * catalog and local-inventory libraries own their screen lists (their `/nav`
 * exports); this file supplies checkin's viewer predicate and the combined
 * section tabs the `/catalog` and `/inventory` layouts render. checkin owns
 * ordering (AppFrame) and the top-level icon; the libraries dictate neither.
 */
import type { TodoCounts } from "@/app/api/nav/todo-counts/route";
import type { SessionUser } from "@/types/auth";
import { INVENTORY_LIBRARY_TABS, visibleLibraryTabs, type NavTab } from "@/lib/libraryNav";
import { CATALOG_NAV_LINKS, CATALOG_TOP_NAV } from "@inventory/global-catalog/nav";
import { INVENTORY_NAV_LINKS } from "@inventory/local-inventory/nav";
import { isLibraryVisible, type LibraryKey } from "@/lib/libraryRelease";

export { CATALOG_TOP_NAV };

/**
 * The Inventory section's tabs: the catalog's screens, then org inventory's
 * (#1287 §7), then the library tabs in INVENTORY_LIBRARY_TABS. Catalog and org
 * inventory show only to a catalog viewer, once their library is released (or to
 * a board member); org inventory's manager-only screens only to an
 * INVENTORY_MANAGER, matching their routes' gate. Each library tab keeps its own
 * gate. Empty means the viewer is not admitted to the section.
 */
export function inventoryAreaLinks(user: SessionUser | undefined, counts: TodoCounts | null): NavTab[] {
  const viewer = isCatalogViewerClient(user);
  const visible = (lib: LibraryKey) =>
    viewer && isLibraryVisible(lib, { isBoardMember: user?.isBoardMember, releasedLibraries: counts?.releasedLibraries });
  const catalog = visible("catalog") ? CATALOG_NAV_LINKS : [];
  const inventory = visible("local-inventory")
    ? INVENTORY_NAV_LINKS.filter((l) => !l.managerOnly || !!user?.isInventoryManager)
    : [];
  return [
    ...[...catalog, ...inventory].map(({ name, href, icon }) => ({ name, href, icon })),
    ...visibleLibraryTabs(INVENTORY_LIBRARY_TABS, user, counts),
  ];
}

/**
 * Client mirror of the server `catalog-viewer` gate (§6): authenticated AND any
 * of — an RBAC role, leading ≥1 program, or a VolunteerDesignation. Every leg is
 * on the session (the volunteer leg rides in as `hasVolunteerDesignation`, set by
 * the JWT callback), so the nav matches server admission exactly — no leg the
 * client can't see. Kept in lockstep with access-resolvers' 'catalog-viewer'.
 */
export function isCatalogViewerClient(user: SessionUser | undefined): boolean {
  if (!user) return false;
  return (
    !!user.isSysadmin ||
    !!user.isBoardMember ||
    !!user.isKeyholder ||
    !!user.isBackgroundCheckReviewer ||
    !!user.isOperations ||
    !!user.isInventoryManager ||
    (user.programsLed?.length ?? 0) > 0 ||
    !!user.hasVolunteerDesignation
  );
}
