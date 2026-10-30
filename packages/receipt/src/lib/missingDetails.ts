/** The details a receipt cannot be checked without. A plain module, so the screens can read it as well as the server. */
export interface ReceiptDetails {
  retailer: string | null;
  receiptDate: string | null;
  receiptTotalCents: number | null;
}

/** Whether `value` is a real calendar date written YYYY-MM-DD, as the date pickers send it. */
export function isIsoDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
}

/**
 * The required details a receipt lacks, in words a person reads: "retailer", "date", "total". A
 * date that is not a real YYYY-MM-DD date counts as missing, since no check can read it.
 */
export function missingDetails(r: ReceiptDetails): string[] {
  const missing: string[] = [];
  if (!r.retailer?.trim()) missing.push("retailer");
  if (!isIsoDate(r.receiptDate?.trim() ?? "")) missing.push("date");
  if (r.receiptTotalCents === null) missing.push("total");
  return missing;
}

/** "retailer", "retailer and date", "retailer, date and total". */
export function listWords(words: string[]): string {
  return words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/** The note a receipt held for its missing details carries. */
export function missingDetailsNote(missing: string[]): string {
  return `This receipt is missing its ${listWords(missing)}. Fill ${missing.length === 1 ? "it" : "them"} in, then confirm.`;
}
