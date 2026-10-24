/** A person's own receipts: the list and the upload screen. The receipt library owns the links. */
import { RECEIPT_SUBMITTER_NAV } from "@checkin/receipt/nav";
import type { NavGate, NavSection } from "@/lib/nav/types";
import type { TodoCounts } from "@/lib/nav/todoCounts";
import { firstVisibleHref, signedIn } from "@/lib/nav/gates";
import { libraryCount, type NavBadge } from "@/components/navBadges";
import { canSubmitReceipts } from "@/lib/volunteer";

const submitter: NavGate = (u) => canSubmitReceipts(u);

/** Green pill: the caller's receipts that wait on them to fix, confirm or re-read. */
function awaitingMe(c: TodoCounts | null): NavBadge | null {
  const n = libraryCount(c, "receipt", "awaitingMe");
  return n > 0 ? { count: n, color: "treehouseGreen", label: `${n} ${n === 1 ? "receipt needs" : "receipts need"} you` } : null;
}

export const MY_RECEIPTS: NavSection = {
  id: "my-receipts",
  label: "My Receipts",
  href: "/my-receipts",
  links: RECEIPT_SUBMITTER_NAV.map((l) => ({
    ...l,
    library: "receipt" as const,
    visible: submitter,
    ...(l.href === "/receipts" ? { badge: awaitingMe } : {}),
  })),
  visible: signedIn,
  hrefFor: (u, c) => firstVisibleHref(MY_RECEIPTS, u, c),
};
