/**
 * Placement of the global-catalog nav in checkin (#1286 §7). The library owns
 * the screen list (labels/hrefs/icons in `@inventory/global-catalog/nav`); this
 * file supplies checkin's viewer predicate and re-exports the section tabs for
 * the `/catalog` layout to render. checkin owns ordering (AppFrame) and the
 * top-level icon; the library never dictates either.
 */
import type { SessionUser } from "@/types/auth";
import type { NavLink } from "@/lib/nav/types";
import { CATALOG_NAV_LINKS, CATALOG_TOP_NAV } from "@inventory/global-catalog/nav";

export { CATALOG_TOP_NAV };
export const CATALOG_NAV_LINKS_CHECKIN: readonly NavLink[] = CATALOG_NAV_LINKS;

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
