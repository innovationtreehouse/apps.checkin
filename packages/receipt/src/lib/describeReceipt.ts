import { formatCents } from "@checkin/money";

/** How a member rejected as a copy reads, before the kept receipt's description. */
export const REJECTED_AS_COPY = "Rejected as a copy of ";
/** How a finalized member whose expense finance rejected reads, before any reason. */
export const EXPENSE_REJECTED = "Finalized · expense rejected by finance";

export const day = (at: Date) => at.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

type Described = { retailer: string | null; receiptDate: string | null; receiptTotalCents: number | null };

/** A receipt's vendor and receipt date, as "Home Depot, 3 Oct". */
export function describeShort(r: Pick<Described, "retailer" | "receiptDate">): string {
  const date = r.receiptDate && /^\d{4}-\d{2}-\d{2}$/.test(r.receiptDate) ? day(new Date(`${r.receiptDate}T00:00:00Z`)) : r.receiptDate;
  return [r.retailer?.trim() || "Receipt", date].filter(Boolean).join(", ");
}

/** A receipt in a line of text: its vendor, receipt date and total, as "Home Depot, 3 Oct, $84.12". */
export function describeReceipt(r: Described): string {
  const total = r.receiptTotalCents == null ? null : formatCents(r.receiptTotalCents);
  return [describeShort(r), total].filter(Boolean).join(", ");
}

/** The receipt kept in place of a copy, by its id alone: the kept receipt may be another person's. */
export const describeKept = (keptId: string): string => `receipt ${keptId}`;
