// Minimal QBO shapes — only the fields we read for ground-truth. Not the full API surface.

export interface QboTokens {
  accessToken: string;
  refreshToken: string;
  obtainedAt: number; // epoch ms
  expiresIn: number; // seconds (access token, ~3600)
  realmId: string;
}

export type QboEnv = "sandbox" | "production";

// A QBO Purchase (expense: cash/card/check). Bills have a similar shape (VendorRef/TxnDate/TotalAmt).
export interface QboPurchase {
  Id: string;
  TxnDate: string; // YYYY-MM-DD
  TotalAmt: number;
  EntityRef?: { value: string; name?: string }; // vendor on a Purchase
  VendorRef?: { value: string; name?: string }; // vendor on a Bill
  CurrencyRef?: { value: string };
  TxnTaxDetail?: { TotalTax?: number };
  DocNumber?: string;
  PrivateNote?: string; // memo — real vendor often lives here on reimbursement bills
  Line?: { Description?: string; Amount?: number }[]; // line detail — real vendor + allocated amounts
}

// What the vendor-join loop actually compares OCR output against.
export interface GroundTruthRecord {
  qbId: string;
  entity: "Purchase" | "Bill";
  vendor: string; // VendorRef/EntityRef name — but on reimbursement bills this is the PERSON, not the vendor
  date: string; // YYYY-MM-DD
  total: number; // TotalAmt — the match anchor
  tax: number;
  currency: string;
  docNumber?: string;
  memo?: string; // PrivateNote — real vendor may be here when `vendor` is a reimbursee
  // Line detail: descriptions carry the real vendor on reimbursement bills; amounts carry the
  // proportionally-allocated (shipping+tax folded in) figures — QB line_i ≈ receiptItem_i × total/subtotal.
  lines?: { description?: string; amount: number }[];
}
