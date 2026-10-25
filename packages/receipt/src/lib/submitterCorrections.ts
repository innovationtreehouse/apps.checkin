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

const isBlank = (value: string | null) => value === null || value.trim() === "" || value === "null";
const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/**
 * The corrections a receipt's submitter made, from their audited field edits oldest first. No tax is
 * stored as $0, so a tax that was $0 before counts as entered.
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
    const beforeCents = isBlank(tax.valueBefore) ? 0 : Number(tax.valueBefore);
    const before = beforeCents === 0 ? null : dollars(beforeCents);
    corrections.push({ field: "tax", kind: before === null ? "entered" : "changed", before, after: dollars(current.taxCents ?? 0) });
  }
  return corrections;
}

/** "the submitter entered the date (2026-10-01)", "the submitter changed the tax from $0.50 to $1.50". */
export function describeCorrection(c: SubmitterCorrection): string {
  return c.kind === "entered" ? `the submitter entered the ${c.field} (${c.after})` : `the submitter changed the ${c.field} from ${c.before} to ${c.after}`;
}
