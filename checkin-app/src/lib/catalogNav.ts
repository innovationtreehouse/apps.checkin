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
 * Client-visible approximation of the server `catalog-viewer` gate (§6). The
 * full predicate also admits volunteers via a VolunteerDesignation email
 * lookup, but the session carries no volunteer flag, so nav visibility uses only
 * the session-available legs: any RBAC role, or leading ≥1 program. A volunteer
 * with no role still reaches every catalog route (the routes run the full gate);
 * they just do not see the nav entry — over-narrow here is safe, never a grant.
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
    (user.programsLed?.length ?? 0) > 0
  );
}
