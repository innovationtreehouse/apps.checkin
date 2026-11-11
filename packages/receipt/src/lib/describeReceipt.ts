import { formatCents } from "@checkin/money";

/** How a member rejected as a copy reads, before the kept receipt's description. */
export const REJECTED_AS_COPY = "Rejected as a copy of ";
/** How a finalized member whose expense finance rejected reads, before any reason. */
export const EXPENSE_REJECTED = "Finalized · expense rejected by finance";

export const day = (at: Date) => at.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

const time = (at: Date) => at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });

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

/**
 * The receipt kept in place of a copy, told apart from its copies, which share its vendor, date
 * and total: "Home Depot, uploaded 3 Oct", with the time when another of `alongside` was
 * uploaded the same day.
 */
export function describeKept(kept: { retailer: string | null; uploadedAt: Date }, alongside: Date[]): string {
  const sameDay = alongside.some((at) => at.getTime() !== kept.uploadedAt.getTime() && day(at) === day(kept.uploadedAt));
  return `${kept.retailer?.trim() || "Receipt"}, uploaded ${day(kept.uploadedAt)}${sameDay ? `, ${time(kept.uploadedAt)}` : ""}`;
}
