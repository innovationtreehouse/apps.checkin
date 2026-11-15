/**
 * The check that a receipt's lines add up to its total. A plain module, so the server's intake
 * flow and the receipt editor apply the same rule. The receipt's printed figures are the record:
 * a printed line total may be its quantity × unit price rounded, and is never changed.
 */
import { formatCents, lineRoundingAgrees } from "@checkin/money";

export interface MathLine {
  quantity: number;
  unitPriceCents: number;
}

export interface StoredLine extends MathLine {
  /** As printed, or quantity × unit price rounded where the receipt prints none. */
  totalPriceCents: number;
}

export interface ReceiptMath {
  /** Line totals + shipping + tax − discount, minus the receipt total, in cents. */
  differenceCents: number;
  /** Positions of lines whose total no rounding of quantity × unit price explains. */
  disagreeing: number[];
  /** Whether every line agrees and the lines add up to the receipt total exactly. */
  balanced: boolean;
}

export function receiptMath(lines: StoredLine[], shippingCents: number, taxCents: number, discountCents: number, receiptTotalCents: number): ReceiptMath {
  const disagreeing = lines.flatMap((l, i) => (lineRoundingAgrees(l.totalPriceCents, l.quantity, l.unitPriceCents) ? [] : [i]));
  const lineSum = lines.reduce((sum, l) => sum + l.totalPriceCents, 0);
  const differenceCents = lineSum + shippingCents + taxCents - discountCents - receiptTotalCents;
  return { differenceCents, disagreeing, balanced: disagreeing.length === 0 && differenceCents === 0 };
}

/** Why a line's total does not add up, e.g. "Line 2: total $10.00 is not 3 × $3.30 ($9.90)". */
export function disagreementText(line: StoredLine, position: number): string {
  const cost = formatCents(Math.round(line.quantity * line.unitPriceCents));
  return `Line ${position + 1}: total ${formatCents(line.totalPriceCents)} is not ${line.quantity} × ${formatCents(line.unitPriceCents)} (${cost})`;
}

/**
 * A line's total after an edit. The stored total, which may be the printed one, stands while it
 * still agrees with the line's quantity × unit price; otherwise it is that cost rounded to the cent.
 */
export function lineTotalAfterEdit(before: StoredLine, after: MathLine): number {
  if (after.quantity === before.quantity && after.unitPriceCents === before.unitPriceCents) return before.totalPriceCents;
  if (lineRoundingAgrees(before.totalPriceCents, after.quantity, after.unitPriceCents)) return before.totalPriceCents;
  return Math.round(after.quantity * after.unitPriceCents);
}
