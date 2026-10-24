/** A person's own receipts: the list and the upload screen. The receipt library owns the links. */
import { RECEIPT_SUBMITTER_NAV } from "@checkin/receipt/nav";
import type { NavGate, NavSection } from "@/lib/nav/types";
import { firstVisibleHref, signedIn } from "@/lib/nav/gates";
import { canSubmitReceipts } from "@/lib/volunteer";

const submitter: NavGate = (u) => canSubmitReceipts(u);

export const MY_RECEIPTS: NavSection = {
  id: "my-receipts",
  label: "My Receipts",
  href: "/my-receipts",
  links: RECEIPT_SUBMITTER_NAV.map((l) => ({ ...l, library: "receipt" as const, visible: submitter })),
  visible: signedIn,
  hrefFor: (u, c) => firstVisibleHref(MY_RECEIPTS, u, c),
};
