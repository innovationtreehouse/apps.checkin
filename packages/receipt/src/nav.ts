/**
 * Nav descriptors for the receipt screens (#1265 §6). The library declares them; the host
 * places them. `RECEIPT_SUBMITTER_NAV` is "My receipts" (anyone who may upload);
 * `RECEIPT_FINANCE_NAV` is the review side (FINANCE works it, BOARD reads it);
 * `RECEIPT_MAIL_NAV` is the held-mail queue, FINANCE only.
 */

export interface ReceiptNavLink {
  name: string;
  href: string;
  /** Emoji icon (the host's SectionTabs render an emoji string). */
  icon: string;
}

/** States only the uploader can move a receipt out of: they fix it, confirm it, or read it again. */
export const SUBMITTER_ACTION_STATES: readonly string[] = ["validation_failed", "submitter_review", "ocr_failed"];

export const RECEIPT_SUBMITTER_NAV: readonly ReceiptNavLink[] = [
  { name: "My receipts", href: "/receipts", icon: "🧾" },
  { name: "Upload", href: "/receipts/upload", icon: "📤" },
];

export const RECEIPT_FINANCE_NAV: readonly ReceiptNavLink[] = [
  { name: "Receipts review", href: "/receipts/review", icon: "🔎" },
  { name: "Receipt settings", href: "/receipts/settings", icon: "⚙️" },
];

export const RECEIPT_MAIL_NAV: readonly ReceiptNavLink[] = [{ name: "Incoming receipt queue", href: "/receipts/mail", icon: "📬" }];
