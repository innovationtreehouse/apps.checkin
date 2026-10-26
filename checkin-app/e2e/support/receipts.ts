/** Receipt setup over HTTP, for specs whose subject is a later page than the upload. */
import { api, BASE, type Session } from "../../flow-tests/helpers";

export interface UploadedReceipt { id: string; state: string }

export interface ManualLine { description: string; quantity: number; unitPrice: number; isDelayed?: boolean }

/** A date `days` before today, as the upload form's date field takes it. */
export const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

async function postUpload(s: Session, text: string, data?: unknown): Promise<UploadedReceipt> {
  const form = new FormData();
  form.append("file", new Blob([text], { type: "text/plain" }), "receipt.txt");
  if (data !== undefined) form.append("data", JSON.stringify(data));
  const req = new Request(BASE, { method: "POST", body: form });
  const res = await api<UploadedReceipt>(s, "/api/receipts/upload", {
    method: "POST",
    body: await req.arrayBuffer(),
    headers: { "content-type": req.headers.get("content-type") ?? "" },
  });
  if (res.status !== 200) throw new Error(`upload answered ${res.status}: ${JSON.stringify(res.json)}`);
  return res.json;
}

/** A typed-in receipt with no tax, shipping or discount, dated yesterday unless given. */
export function uploadManual(s: Session, retailer: string, lines: ManualLine[], receiptDate = daysAgo(1)): Promise<UploadedReceipt> {
  const totalCents = lines.reduce((sum, l) => sum + Math.round(l.unitPrice * 100) * l.quantity, 0);
  return postUpload(s, `${retailer} ${Date.now()}`, {
    needsReimbursement: false,
    isInKind: false,
    details: {
      retailer,
      receiptDate,
      currency: "USD",
      receiptTotal: (totalCents / 100).toFixed(2),
      tax: "0",
      shipping: "0",
      discount: "0",
      lineItems: lines.map((l) => ({ isDelayed: false, ...l, partNumber: null, manufacturer: null })),
    },
  });
}

/** A receipt the local OCR mock reads; it reads every file as the same purchase. */
export const uploadForReading = (s: Session, text: string) => postUpload(s, text);

/** An OCR-read receipt waiting on its submitter's review; FINANCE clears a duplicate flag an earlier read caused. */
export async function inReview(submitter: Session, finance: Session, text: string): Promise<UploadedReceipt> {
  const receipt = await uploadForReading(submitter, text);
  if (receipt.state !== "duplicate_flagged") return receipt;
  const cleared = await api<UploadedReceipt>(finance, `/api/receipts/${receipt.id}/clear-duplicate`, { method: "POST", body: "{}" });
  if (cleared.json.state !== "submitter_review") throw new Error(`clearing the duplicate left the receipt ${cleared.json.state}`);
  return cleared.json;
}

export interface InReceiving { receiptId: string; receivedId: number }

/** A typed-in receipt, done on upload and now waiting in Part mapping. */
export async function inReceiving(s: Session, retailer: string, lines: ManualLine[]): Promise<InReceiving> {
  const receipt = await uploadManual(s, retailer, lines);
  if (receipt.state !== "receipt_finalized") throw new Error(`the typed-in receipt is ${receipt.state}, not done`);
  const rows = await api<Array<{ id: number; receiptId: string }>>(s, "/api/workflow-mapping/receipts");
  const row = rows.json.find((r) => r.receiptId === receipt.id);
  if (!row) throw new Error(`receipt ${receipt.id} did not reach Part mapping`);
  return { receiptId: receipt.id, receivedId: row.id };
}

/** A typed-in receipt carried through Part mapping with every line not inventory; its expense has the receipt's id. */
export async function expenseFrom(manager: Session, retailer: string, lines: ManualLine[]): Promise<string> {
  const { receiptId, receivedId } = await inReceiving(manager, retailer, lines);
  const detail = await api<{ ReceivedReceiptLineStatus: Array<{ id: number }> }>(manager, `/api/workflow-mapping/receipts/${receivedId}`);
  for (const line of detail.json.ReceivedReceiptLineStatus) {
    const res = await api(manager, `/api/workflow-mapping/receipts/${receivedId}/lines/${line.id}/non-inventory`, { method: "POST", body: "{}" });
    if (res.status !== 200) throw new Error(`non-inventory answered ${res.status}`);
  }
  return receiptId;
}
