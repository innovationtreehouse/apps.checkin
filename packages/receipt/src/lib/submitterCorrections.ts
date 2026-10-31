import { formatCents } from "@checkin/money";
/**
 * A submitter's tax or date edits, told apart as entered (the field was blank) or changed (it held
 * a value). A plain module, so the server's review reason and the receipt page word them alike.
 */
export interface FieldEdit {
  fieldChanged: string | null;
  valueBefore: string | null;
}

export interface SubmitterCorrection {
  field: "date" | "tax";
  kind: "entered" | "changed";
  /** The value before the submitter's first edit, as shown; null when it was blank. */
  before: string | null;
  /** The value now, as shown. */
  after: string;
}

/** The audit action of a reading that replaced a receipt's details and lines. */
export const READING_APPLIED = "ocr_complete";

/**
 * The field edits among a receipt's audit rows that still describe it. A reading replaces every
 * detail, so edits before the latest one are history, not corrections of what the receipt now says.
 */
export function editsSinceReading<T extends { id: number; action: string }>(rows: T[]): T[] {
  const reading = Math.max(0, ...rows.filter((r) => r.action === READING_APPLIED).map((r) => r.id));
  return rows.filter((r) => r.action === "field_edit" && r.id > reading);
}

const isBlank = (value: string | null) => value === null || value.trim() === "" || value === "null";

/**
 * The corrections a receipt's submitter made, from their audited field edits oldest first. Only a
 * field that was truly blank counts as entered; a $0 tax was a value, so changing it is a change.
 */
export function submitterCorrections(edits: FieldEdit[], current: { taxCents: number | null; receiptDate: string | null }): SubmitterCorrection[] {
  const first = (field: string) => edits.find((e) => e.fieldChanged === field);
  const corrections: SubmitterCorrection[] = [];
  const date = first("receiptDate");
  if (date) {
    const before = isBlank(date.valueBefore) ? null : date.valueBefore;
    corrections.push({ field: "date", kind: before === null ? "entered" : "changed", before, after: current.receiptDate ?? "" });
  }
  const tax = first("taxCents");
  if (tax) {
    const before = isBlank(tax.valueBefore) ? null : formatCents(Number(tax.valueBefore));
    corrections.push({ field: "tax", kind: before === null ? "entered" : "changed", before, after: formatCents(current.taxCents ?? 0) });
  }
  return corrections;
}

/** "the submitter entered the date (2026-10-01)", "the submitter changed the tax from $0.50 to $1.50". */
export function describeCorrection(c: SubmitterCorrection): string {
  return c.kind === "entered" ? `the submitter entered the ${c.field} (${c.after})` : `the submitter changed the ${c.field} from ${c.before} to ${c.after}`;
}
