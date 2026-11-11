/** A person's own receipts: the list and the upload screen. The receipt library owns the links. */
import { RECEIPT_CONFIRM_NAV, RECEIPT_SUBMITTER_NAV } from "@checkin/receipt/nav";
import type { NavGate, NavSection } from "@/lib/nav/types";
import type { TodoCounts } from "@/lib/nav/todoCounts";
import { firstVisibleHref, signedIn } from "@/lib/nav/gates";
import { libraryCount, type NavBadge } from "@/components/navBadges";
import { canSubmitReceipts } from "@/lib/volunteer";

const submitter: NavGate = (u) => canSubmitReceipts(u);

/** Anyone who may be named as reimbursee (an adult, whatever their membership or role), and the Board. */
const confirmer: NavGate = (u) => u?.ageBand === "adult" || u?.isBoardMember === true;

/** Green pill: the caller's receipts that wait on them to fix, confirm or re-read. */
function awaitingMe(c: TodoCounts | null): NavBadge | null {
  const n = libraryCount(c, "receipt", "awaitingMe");
  return n > 0 ? { count: n, color: "treehouseGreen", label: `${n} ${n === 1 ? "receipt needs" : "receipts need"} you` } : null;
}

/** Green pill: reimbursements waiting for the caller's confirmation. */
function toConfirm(c: TodoCounts | null): NavBadge | null {
  const n = libraryCount(c, "receipt", "toConfirm");
  return n > 0 ? { count: n, color: "treehouseGreen", label: `${n} ${n === 1 ? "receipt waits" : "receipts wait"} for your confirmation` } : null;
}

export const MY_RECEIPTS: NavSection = {
  id: "my-receipts",
  label: "My Receipts",
  href: "/my-receipts",
  links: [
    ...RECEIPT_SUBMITTER_NAV.map((l) => ({
      ...l,
      library: "receipt" as const,
      visible: submitter,
      ...(l.href === "/receipts" ? { badge: awaitingMe } : {}),
    })),
    { ...RECEIPT_CONFIRM_NAV, library: "receipt" as const, visible: confirmer, badge: toConfirm },
  ],
  visible: signedIn,
  hrefFor: (u, c) => firstVisibleHref(MY_RECEIPTS, u, c),
};
