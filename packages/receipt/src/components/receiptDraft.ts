/**
 * Unsaved edits to a receipt on its detail page, and the writes that save them. Amounts are kept
 * as the dollar strings a person typed; the routes take dollars as numbers.
 */
import { receiptMath, type MathLine, type ReceiptMath } from "../lib/lineMath";
import { MAX_LINE_ITEMS } from "../lib/schemas";

export interface ServerLine {
  id: number;
  lineNumber: number;
  description: string;
  partNumber?: string | null;
  manufacturer?: string | null;
  quantity: number;
  unitPriceCents: number;
  totalPriceCents: number;
  isDelayed: boolean;
}

export interface ServerReceipt {
  retailer: string | null;
  receiptDate: string | null;
  receiptTotalCents: number | null;
  taxCents: number | null;
  shippingCents: number | null;
  discountCents: number | null;
  lineItems: ServerLine[];
}

export interface DraftLine {
  description: string;
  partNumber: string;
  manufacturer: string;
  quantity: string;
  unitPrice: string;
  isDelayed: boolean;
}

export interface Header {
  retailer: string;
  receiptDate: string;
  shipping: string;
  tax: string;
  discount: string;
  receiptTotal: string;
}

export interface AddedLine extends DraftLine {
  key: number;
}

export interface Draft {
  header: Partial<Header>;
  lines: Record<number, Partial<DraftLine>>;
  added: AddedLine[];
  removed: number[];
}

export interface SaveOp {
  path: string;
  method: "PATCH" | "POST" | "DELETE";
  body?: Record<string, unknown>;
  /** The added line this write creates. */
  addedKey?: number;
}

export const EMPTY_DRAFT: Draft = { header: {}, lines: {}, added: [], removed: [] };
export const EMPTY_LINE: DraftLine = { description: "", partNumber: "", manufacturer: "", quantity: "1", unitPrice: "0.00", isDelayed: false };

export const toDollars = (cents: number | null | undefined) => ((cents ?? 0) / 100).toFixed(2);

/** Signed dollars for a cents amount, e.g. "-$1.50". */
export const signedDollars = (cents: number) => `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toFixed(2)}`;

/** A typed dollar amount in cents; null unless it is a non-negative number. */
export function parseCents(value: string): number | null {
  const v = value.trim().replace(/^\$/, "");
  if (!/^(\d+\.?\d*|\.\d+)$/.test(v)) return null;
  return Math.round(parseFloat(v) * 100);
}

/** A typed quantity; null unless it is a positive number. */
export function parseQuantity(value: string): number | null {
  const n = Number(value.trim());
  return value.trim() !== "" && Number.isFinite(n) && n > 0 ? n : null;
}

export function lineFromServer(l: ServerLine): DraftLine {
  return {
    description: l.description,
    partNumber: l.partNumber ?? "",
    manufacturer: l.manufacturer ?? "",
    quantity: String(l.quantity),
    unitPrice: toDollars(l.unitPriceCents),
    isDelayed: l.isDelayed,
  };
}

export function headerFromServer(r: ServerReceipt): Header {
  return {
    retailer: r.retailer ?? "",
    receiptDate: r.receiptDate ?? "",
    shipping: toDollars(r.shippingCents),
    tax: toDollars(r.taxCents),
    discount: toDollars(r.discountCents),
    // A total OCR could not read stays blank, so the submitter types it rather than keeping $0.00.
    receiptTotal: r.receiptTotalCents === null ? "" : toDollars(r.receiptTotalCents),
  };
}

/** The receipt's lines as the draft shows them: kept server lines with edits applied, then added lines. */
export function draftLines(r: ServerReceipt, draft: Draft): DraftLine[] {
  const kept = r.lineItems.filter((l) => !draft.removed.includes(l.id)).map((l) => ({ ...lineFromServer(l), ...draft.lines[l.id] }));
  return [...kept, ...draft.added];
}

export function draftHeader(r: ServerReceipt, draft: Draft): Header {
  return { ...headerFromServer(r), ...draft.header };
}

/** Line cost in cents, as the server's math check counts it (quantity × unit price, unrounded). */
export function lineCents(line: DraftLine): number | null {
  const quantity = parseQuantity(line.quantity);
  const unit = parseCents(line.unitPrice);
  return quantity === null || unit === null ? null : quantity * unit;
}

/** Lines + shipping + tax − discount, in cents, the sum the receipt total must equal; null while any amount is unreadable. */
export function calculatedCents(lines: DraftLine[], header: Header): number | null {
  const parts = [...lines.map(lineCents), parseCents(header.shipping), parseCents(header.tax)];
  const discount = parseCents(header.discount);
  if (discount === null || parts.some((p) => p === null)) return null;
  return (parts as number[]).reduce((a, b) => a + b, 0) - discount;
}

/** The server's math check on these lines and header; null while any amount is unreadable. */
export function headerMath(lines: DraftLine[], header: Header): ReceiptMath | null {
  const mathLines: MathLine[] = [];
  for (const l of lines) {
    const quantity = parseQuantity(l.quantity);
    const unitPriceCents = parseCents(l.unitPrice);
    if (quantity === null || unitPriceCents === null) return null;
    mathLines.push({ quantity, unitPriceCents });
  }
  const [shipping, tax, discount, total] = [header.shipping, header.tax, header.discount, header.receiptTotal].map(parseCents);
  if (shipping === null || tax === null || discount === null || total === null) return null;
  return receiptMath(mathLines, shipping, tax, discount, total);
}

/** The server's math check on the receipt as the draft would save it. */
export function draftMath(r: ServerReceipt, draft: Draft): ReceiptMath | null {
  return headerMath(draftLines(r, draft), draftHeader(r, draft));
}

/** A difference as signed dollars at its real size, fractions of a cent included. */
export function differenceDollars(cents: number): string {
  const dollars = (Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });
  return `${cents < 0 ? "-" : ""}$${dollars}`;
}

/** How much rounding the check allowed, as a phrase to follow a difference; empty when none was. */
export function roundingAllowed(allowedCents: number): string {
  return allowedCents > 0 ? ` (rounding of up to ${signedDollars(allowedCents)} allowed)` : "";
}

/**
 * Whether one more line fits under the server's cap. Lines are added before removals are saved,
 * so the saved lines count in full until then.
 */
export function canAddLine(r: ServerReceipt, draft: Draft): boolean {
  return r.lineItems.length + draft.added.length < MAX_LINE_ITEMS;
}

/** Why the draft cannot be saved, or null when it can. */
export function draftProblem(r: ServerReceipt, draft: Draft): string | null {
  const header = draftHeader(r, draft);
  const lines = draftLines(r, draft);
  if (!header.retailer.trim()) return "The retailer is required.";
  if (!header.receiptDate.trim()) return "The date is required.";
  if ([header.shipping, header.tax, header.discount, header.receiptTotal].some((v) => parseCents(v) === null)) {
    return "Shipping, tax, discount and total must be dollar amounts.";
  }
  if (lines.length === 0) return "A receipt keeps at least one line.";
  if (r.lineItems.length + draft.added.length > MAX_LINE_ITEMS) return `A receipt holds at most ${MAX_LINE_ITEMS} lines; save the removals first.`;
  if (lines.some((l) => !l.description.trim())) return "Every line needs a description.";
  if (lines.some((l) => parseQuantity(l.quantity) === null)) return "Every quantity must be a positive number.";
  if (lines.some((l) => parseCents(l.unitPrice) === null)) return "Every unit price must be a dollar amount.";
  return null;
}

function changed<T extends object>(base: T, edits: Partial<T>): (keyof T)[] {
  return (Object.keys(edits) as (keyof T)[]).filter((k) => edits[k] !== undefined && edits[k] !== base[k]);
}

const dollarsOf = (value: string) => (parseCents(value) ?? 0) / 100;

function lineBody(line: Partial<DraftLine>, fields: (keyof DraftLine)[]): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const f of fields) {
    const v = line[f];
    if (f === "quantity") body.quantity = Number(v);
    else if (f === "unitPrice") body.unitPrice = dollarsOf(String(v));
    else if (f === "partNumber" || f === "manufacturer") body[f] = String(v).trim() || null;
    else if (f === "description") body.description = String(v).trim();
    else body[f] = v;
  }
  return body;
}

export function isDirty(r: ServerReceipt, draft: Draft): boolean {
  return planSave(r, draft).length > 0;
}

/**
 * The writes that bring the saved receipt to the draft. Lines are added before any is removed,
 * so the receipt never passes through having none.
 */
export function planSave(r: ServerReceipt, draft: Draft): SaveOp[] {
  const ops: SaveOp[] = [];
  const header = headerFromServer(r);
  const headerFields = changed(header, draft.header);
  if (headerFields.length > 0) {
    const body: Record<string, unknown> = {};
    for (const f of headerFields) {
      const v = draft.header[f] ?? "";
      body[f] = f === "retailer" || f === "receiptDate" ? v.trim() : dollarsOf(v);
    }
    ops.push({ path: "", method: "PATCH", body });
  }
  for (const l of r.lineItems) {
    const edits = draft.lines[l.id];
    if (!edits || draft.removed.includes(l.id)) continue;
    const fields = changed(lineFromServer(l), edits);
    if (fields.length > 0) ops.push({ path: `/line-items/${l.id}`, method: "PATCH", body: lineBody(edits, fields) });
  }
  for (const a of draft.added) {
    const all = Object.keys(EMPTY_LINE) as (keyof DraftLine)[];
    ops.push({ path: "/line-items", method: "POST", body: lineBody(a, all), addedKey: a.key });
  }
  for (const l of r.lineItems) {
    if (draft.removed.includes(l.id)) ops.push({ path: `/line-items/${l.id}`, method: "DELETE" });
  }
  return ops;
}
