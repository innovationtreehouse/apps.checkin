/**
 * The finance side of receipts: review and settings for FINANCE or BOARD, the
 * held-mail queue for FINANCE alone (it shows sender addresses). The receipt
 * library owns the links.
 */
import { RECEIPT_FINANCE_NAV, RECEIPT_MAIL_NAV } from "@checkin/receipt/nav";
import type { NavSection } from "@/lib/nav/types";
import { FINANCE_OR_BOARD, anyRole, firstVisibleHref } from "@/lib/nav/gates";

export const RECEIPT_REVIEW: NavSection = {
  id: "receipt-review",
  label: "Receipt Review",
  href: "/receipts/review",
  links: [
    ...RECEIPT_FINANCE_NAV.map((l) => ({ ...l, library: "receipt" as const })),
    ...RECEIPT_MAIL_NAV.map((l) => ({ ...l, library: "receipt" as const, visible: anyRole(["isFinance"]) })),
  ],
  visible: anyRole(FINANCE_OR_BOARD),
  hrefFor: (u, c) => firstVisibleHref(RECEIPT_REVIEW, u, c),
};
