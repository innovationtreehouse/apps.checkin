/** The details a receipt cannot be checked without. A plain module, so the screens can read it as well as the server. */
export interface ReceiptDetails {
  retailer: string | null;
  receiptDate: string | null;
  receiptTotalCents: number | null;
}

/** The required details a receipt lacks, in words a person reads: "retailer", "date", "total". */
export function missingDetails(r: ReceiptDetails): string[] {
  const missing: string[] = [];
  if (!r.retailer?.trim()) missing.push("retailer");
  if (!r.receiptDate?.trim()) missing.push("date");
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
