// Minimal QBO shapes — only the fields we read for ground-truth. Not the full API surface.

export interface QboTokens {
  accessToken: string;
  refreshToken: string;
  obtainedAt: number; // epoch ms
  expiresIn: number; // seconds (access token, ~3600)
  realmId: string;
}

export type QboEnv = "sandbox" | "production";

/** Which QBO company the client talks to. Production is allowed only when CHECKIN_ENV=prod. */
export interface QboRealm {
  env: QboEnv;
  realmId: string;
}

/**
 * Read-only source of the current QBO access token. The app never refreshes or
 * stores tokens: an external refresher owns rotation and publishes the token.
 */
export interface AccessTokenSource {
  current(): Promise<string>;
}

export interface QboRef {
  value: string;
  name?: string;
}

// A QBO Purchase (expense: cash/card/check). Bills have a similar shape (VendorRef/TxnDate/TotalAmt).
export interface QboPurchase {
  Id: string;
  TxnDate: string; // YYYY-MM-DD
  TotalAmt: number;
  EntityRef?: { value: string; name?: string }; // vendor on a Purchase
  VendorRef?: { value: string; name?: string }; // vendor on a Bill
  AccountRef?: QboRef; // the card or bank account a Purchase was paid from
  PaymentType?: "Cash" | "Check" | "CreditCard";
  CurrencyRef?: { value: string };
  TxnTaxDetail?: { TotalTax?: number };
  DocNumber?: string;
  PrivateNote?: string; // memo — real vendor often lives here on reimbursement bills
  Line?: { Description?: string; Amount?: number }[]; // line detail — real vendor + allocated amounts
}

/** A Bill. `Balance` 0 means paid; `LinkedTxn` names the BillPayments that paid it. */
export interface QboBill extends QboPurchase {
  Balance?: number;
  DueDate?: string;
  LinkedTxn?: QboLinkedTxn[];
}

export interface QboLinkedTxn {
  TxnId: string;
  TxnType: string;
}

export interface QboDeposit {
  Id: string;
  TxnDate: string;
  TotalAmt: number;
  DepositToAccountRef?: QboRef;
  PrivateNote?: string;
  Line?: { Description?: string; Amount?: number }[];
}

export interface QboBillPayment {
  Id: string;
  TxnDate: string;
  TotalAmt: number;
  VendorRef?: QboRef;
  PayType?: string;
  Line?: { Amount?: number; LinkedTxn?: QboLinkedTxn[] }[];
}

export interface QboAccount {
  Id: string;
  Name: string;
  FullyQualifiedName: string;
  AccountType?: string;
  Active?: boolean;
}

export interface QboClass {
  Id: string;
  Name: string;
  FullyQualifiedName: string;
  Active?: boolean;
}

export interface QboVendor {
  Id: string;
  DisplayName: string;
  Active?: boolean;
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
