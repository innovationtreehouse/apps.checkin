/**
 * Placement of the bulk-donation section in checkin (#1280 §5). The library
 * owns its screen list (its `/nav` export); this file supplies the client gate
 * the /donations layout and the page registry share.
 */
import type { NavLink } from "@/lib/nav/types";
import { DONATION_NAV_LINKS } from "@inventory/bulk-donation/nav";

export { DONATION_NAV_LINKS };

export const donationAreaLinks: NavLink[] = DONATION_NAV_LINKS.map(({ name, href, icon }) => ({ name, href, icon }));

/**
 * Client mirror of the server `finance-or-board` gate: FINANCE or BOARD only.
 * Sysadmin is excluded, as on every finance route.
 */
export function isDonationViewerClient(user: { isFinance?: boolean; isBoardMember?: boolean } | undefined): boolean {
  return !!user?.isFinance || !!user?.isBoardMember;
}
