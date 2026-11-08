/**
 * The check that a receipt's lines add up to its total. A plain module, so the server's intake
 * flow and the receipt editor apply the same rule.
 */
export interface MathLine {
  quantity: number;
  unitPriceCents: number;
}

export interface ReceiptMath {
  /** Lines + shipping + tax − discount, minus the receipt total, in cents. */
  differenceCents: number;
  /** The rounding allowed, in cents: one per line whose cost is a fraction of a cent. */
  allowedCents: number;
  /** Whether the difference is within the rounding allowed; exact when no line has a fraction of a cent. */
  balanced: boolean;
}

// Floating-point noise in quantity × unit price, not a real fraction of a cent.
const NOISE = 1e-6;

export function receiptMath(lines: MathLine[], shippingCents: number, taxCents: number, discountCents: number, receiptTotalCents: number): ReceiptMath {
  let lineSum = 0;
  let fractional = 0;
  for (const line of lines) {
    const cost = line.quantity * line.unitPriceCents;
    const whole = Math.round(cost);
    if (Math.abs(cost - whole) < NOISE) {
      lineSum += whole;
    } else {
      lineSum += cost;
      fractional += 1;
    }
  }
  const differenceCents = lineSum + shippingCents + taxCents - discountCents - receiptTotalCents;
  return { differenceCents, allowedCents: fractional, balanced: Math.abs(differenceCents) <= fractional + NOISE };
}

export interface StoredLine extends MathLine {
  totalPriceCents: number;
}

/**
 * A line's total after an edit. The stored total, which may be the receipt's printed figure, stands
 * unless the quantity or unit price changes; then it is that quantity × unit price, the cost the
 * math check counts.
 */
export function lineTotalAfterEdit(before: StoredLine, after: MathLine): number {
  if (after.quantity === before.quantity && after.unitPriceCents === before.unitPriceCents) return before.totalPriceCents;
  return Math.round(after.quantity * after.unitPriceCents);
}
