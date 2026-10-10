/**
 * Placement of the receipt screens in checkin (#1265 §6). The library owns the screen lists
 * (its `/nav` export); this file supplies checkin's audience predicates, mirroring the routes'
 * gates: submitters are the catalog-viewer audience (which admits FINANCE), and the review
 * side is FINANCE or BOARD. No sysadmin leg: Finance Ops excludes sysadmins.
 */
import type { SessionUser } from "@/types/auth";
import type { NavLink } from "@/lib/nav/types";
import { RECEIPT_FINANCE_NAV, RECEIPT_SUBMITTER_NAV } from "@inventory/receipt/nav";
import { isCatalogViewerClient } from "@/lib/catalogNav";

export function isReceiptSubmitterClient(user: SessionUser | undefined): boolean {
  return isCatalogViewerClient(user) || !!user?.isFinance;
}

export function isReceiptReviewerClient(user: SessionUser | undefined): boolean {
  return !!user?.isFinance || !!user?.isBoardMember;
}

/** The /receipts section's tabs: "My receipts" for submitters, then the review side. */
export function receiptAreaLinks(user: SessionUser | undefined): NavLink[] {
  return [
    ...(isReceiptSubmitterClient(user) ? RECEIPT_SUBMITTER_NAV : []),
    ...(isReceiptReviewerClient(user) ? RECEIPT_FINANCE_NAV : []),
  ].map(({ name, href, icon }) => ({ name, href, icon }));
}
