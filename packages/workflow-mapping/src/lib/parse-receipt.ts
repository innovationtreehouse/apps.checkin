import { CompletedReceiptSchema, type CompletedReceipt } from "@inventory/receipt-types";

export type ParseStoredReceiptResult =
  | { ok: true; receipt: CompletedReceipt }
  | { ok: false; error: string };

/**
 * Guarded parse of a stored receipt's JSON column. Corrupt stored data is a
 * data-integrity signal, not a client error, so callers should log the failure
 * server-side and surface a clean 422 rather than letting JSON.parse / Zod throw
 * and 500 with a stack trace.
 */
export function parseStoredReceipt(receiptJson: string): ParseStoredReceiptResult {
  let raw: unknown;
  try {
    raw = JSON.parse(receiptJson);
  } catch {
    return { ok: false, error: "Stored receipt data is not valid JSON" };
  }

  const result = CompletedReceiptSchema.safeParse(raw);
  if (!result.success) {
    return { ok: false, error: "Stored receipt data failed validation" };
  }

  return { ok: true, receipt: result.data };
}
