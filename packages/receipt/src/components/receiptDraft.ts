/**
 * Unsaved edits to a receipt on its detail page, and the writes that save them. Amounts are kept
 * as the dollar strings a person typed; the routes take dollars as numbers.
 */
import { centsToDecimalString, dollarsToCents } from "@checkin/money";
import { disagreementText, lineTotalAfterEdit, receiptMath, type ReceiptMath, type StoredLine } from "../lib/lineMath";
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
  /** The line total as typed; blank, or a saved line's stored total, leaves it to quantity × unit price. */
  total: string;
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
export const EMPTY_LINE: DraftLine = { description: "", partNumber: "", manufacturer: "", quantity: "1", unitPrice: "0.00", total: "", isDelayed: false };

export const toDollars = (cents: number | null | undefined) => centsToDecimalString(cents ?? 0);

/** A typed dollar amount in cents; null unless it is a non-negative number. */
export function parseCents(value: string): number | null {
  const v = value.trim().replace(/^\$/, "");
  if (!/^(\d+\.?\d*|\.\d+)$/.test(v)) return null;
  return dollarsToCents(v);
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
    total: toDollars(l.totalPriceCents),
    isDelayed: l.isDelayed,
  };
}

export function headerFromServer(r: ServerReceipt): Header {
  return {
    // Trimmed, so a stored value of only spaces shows as the blank it is and the save asks for it.
    retailer: (r.retailer ?? "").trim(),
    receiptDate: (r.receiptDate ?? "").trim(),
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

/**
 * Whether a person typed this line's total: a saved line's draft edits hold one, or an added line
 * has one. A blank field leaves the total to the stored or calculated one.
 */
export function totalTyped(total: string | undefined): boolean {
  return Boolean(total?.trim());
}

/** A draft line as the server would store it; null while its quantity, unit price or typed total is unreadable. */
function storedLine(line: DraftLine, typed: boolean, saved?: ServerLine): StoredLine | null {
  const quantity = parseQuantity(line.quantity);
  const unitPriceCents = parseCents(line.unitPrice);
  if (quantity === null || unitPriceCents === null) return null;
  const after = { quantity, unitPriceCents };
  if (typed) {
    const typed = parseCents(line.total);
    return typed === null ? null : { ...after, totalPriceCents: typed };
  }
  return { ...after, totalPriceCents: saved ? lineTotalAfterEdit(saved, after) : Math.round(quantity * unitPriceCents) };
}

export interface Balance {
  /** Each line's total as the server would store it, kept lines then added ones. */
  lineTotalsCents: (number | null)[];
  subtotalCents: number | null;
  /** Lines + shipping + tax − discount. */
  calculatedCents: number | null;
  /** Calculated minus the receipt total. */
  differenceCents: number | null;
  /** The server's math check; null while any amount is unreadable. */
  math: ReceiptMath | null;
  /** Each line whose total no rounding of quantity × unit price explains, as a sentence. */
  disagreements: string[];
}

const sumOrNull = (values: (number | null)[]) => (values.some((v) => v === null) ? null : (values as number[]).reduce((a, b) => a + b, 0));

/** The receipt's figures as the draft would save them. */
export function draftBalance(r: ServerReceipt, draft: Draft): Balance {
  const kept = r.lineItems.filter((l) => !draft.removed.includes(l.id)).map((l) => storedLine({ ...lineFromServer(l), ...draft.lines[l.id] }, totalTyped(draft.lines[l.id]?.total), l));
  const lines = [...kept, ...draft.added.map((a) => storedLine(a, totalTyped(a.total)))];
  const header = draftHeader(r, draft);
  const [shipping, tax, discount, total] = [header.shipping, header.tax, header.discount, header.receiptTotal].map(parseCents);
  const lineTotalsCents = lines.map((l) => l?.totalPriceCents ?? null);
  const subtotalCents = sumOrNull(lineTotalsCents);
  const calculatedCents = subtotalCents === null || shipping === null || tax === null || discount === null ? null : subtotalCents + shipping + tax - discount;
  const differenceCents = calculatedCents === null || total === null ? null : calculatedCents - total;
  const readable = differenceCents === null ? null : (lines as StoredLine[]);
  const math = readable && total !== null ? receiptMath(readable, shipping ?? 0, tax ?? 0, discount ?? 0, total) : null;
  const disagreements = readable && math ? math.disagreeing.map((i) => disagreementText(readable[i], i)) : [];
  return { lineTotalsCents, subtotalCents, calculatedCents, differenceCents, math, disagreements };
}

/** The server's math check on the receipt as the draft would save it. */
export function draftMath(r: ServerReceipt, draft: Draft): ReceiptMath | null {
  return draftBalance(r, draft).math;
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
  if (lines.some((l) => l.total.trim() !== "" && parseCents(l.total) === null)) return "Every line total must be a dollar amount.";
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
    else if (f === "total") {
      if (String(v).trim()) body.totalPrice = dollarsOf(String(v));
    }
    else if (f === "partNumber" || f === "manufacturer") body[f] = String(v).trim() || null;
    else if (f === "description") body.description = String(v).trim();
    else body[f] = v;
  }
  return body;
}

/** Whether a receipt OCR could not read holds details: a failed reading saves nothing, so a person typed them. */
export function hasTypedDetails(r: ServerReceipt): boolean {
  return Boolean(r.retailer || r.receiptDate || r.taxCents || r.shippingCents || r.discountCents) || r.receiptTotalCents !== null || r.lineItems.length > 0;
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
    const fields: (keyof DraftLine)[] = changed(lineFromServer(l), edits).filter((f) => f !== "total");
    // A typed total is sent when it differs from the stored one, or when the quantity or unit price
    // changes, since the server would otherwise recalculate it. A cleared total leaves it to the server.
    const totalChanged = edits.total !== toDollars(l.totalPriceCents) || fields.includes("quantity") || fields.includes("unitPrice");
    if (totalTyped(edits.total) && totalChanged) fields.push("total");
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
