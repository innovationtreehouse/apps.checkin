import { allocateCents } from "@checkin/money";
import type { MirrorBalanceTxn, MirrorOrderLine } from "../contract";

/**
 * Logical account a deposit line books to. `income` carries its item's QuickBooks account and
 * bucket (null for organization level); the others resolve to a books-map role at booking.
 * The mirror has no per-order tax or shipping, so both land in `charge_remainder`.
 */
export type DepositAccount = "income" | "charge_remainder" | "fees" | "adjustments";

export interface DepositLine {
  account: DepositAccount;
  /** The QuickBooks account a sale line books to; null on every other line, and on a sale with no item. */
  accountId: string | null;
  budgetOwnerId: number | null;
  amountCents: number;
}

export interface DepositLineInput {
  payoutNetCents: number;
  txns: MirrorBalanceTxn[];
  orderLines: MirrorOrderLine[];
  /** variantId → budget-owner bucket id; null books at organization level. The create path holds a payout with an undecided item, or a sale with no or only some lines, as NEEDS_MAPPING first. */
  categories: ReadonlyMap<string, number | null>;
  /** variantId → the QuickBooks account the item's sales book to. */
  accounts: ReadonlyMap<string, string>;
  /** The account custom items (lines with no variant) book to as general income. */
  customItemsAccountId?: string;
}

const lineAmount = (l: MirrorOrderLine) => Math.max(0, l.priceCents * l.quantity - l.discountCents);

/** A line's amount scaled to the units it has lost; rounded, so `split` can treat it as a line amount. */
const refundedAmount = (l: MirrorOrderLine) =>
  l.quantity ? Math.round((lineAmount(l) * Math.max(0, l.quantity - l.currentQuantity)) / l.quantity) : 0;

/**
 * The amounts a refund splits by: what each line has lost in refunded units, or the full line
 * amounts when no units went back, as with a refund of part of the money.
 * ponytail: the mirror keeps cumulative units per line, not per refund, so a later refund also weights lines an earlier refund took units from; use per-refund lines if the mirror ever keeps them.
 */
function refundWeights(lines: MirrorOrderLine[]): number[] {
  const refunded = lines.map(refundedAmount);
  return refunded.some((a) => a > 0) ? refunded : lines.map(lineAmount);
}

/**
 * Split `amount` (any sign) by per-line `amounts`: each line gets its own amount when the total
 * covers them all, the rest left for organization level; otherwise the lines share it all in
 * whole cents through the shared allocator.
 */
function split(amount: number, amounts: number[]): { parts: number[]; remainder: number } {
  const total = amounts.reduce((s, a) => s + a, 0);
  if (total === 0) return { parts: amounts.map(() => 0), remainder: amount };
  if (Math.abs(amount) >= total) {
    const parts = amounts.map((a) => Math.sign(amount) * a);
    return { parts, remainder: amount - parts.reduce((s, p) => s + p, 0) };
  }
  return { parts: allocateCents(amount, amounts), remainder: 0 };
}

/**
 * Build the lines of a deposit the app creates for one payout. A charge splits across
 * its order's lines by line amount and a refund by the lines' refunded units, and each part
 * books to its item's account and bucket, one line per account and bucket; tax and shipping book at organization level; each transaction's fee (net − amount) books to
 * fees; every other transaction type books whole to adjustments. Lines sum to the payout net.
 */
export function buildDepositLines(input: DepositLineInput): DepositLine[] {
  const byOrder = new Map<string, MirrorOrderLine[]>();
  for (const l of input.orderLines) byOrder.set(l.orderGid, [...(byOrder.get(l.orderGid) ?? []), l]);

  const totals = new Map<string, DepositLine>();
  const add = (account: DepositAccount, budgetOwnerId: number | null, amountCents: number, accountId: string | null = null) => {
    if (amountCents === 0) return;
    const key = `${account}:${accountId ?? ""}:${budgetOwnerId ?? "org"}`;
    const line = totals.get(key) ?? { account, accountId, budgetOwnerId, amountCents: 0 };
    line.amountCents += amountCents;
    totals.set(key, line);
  };

  for (const t of input.txns) {
    const type = t.type.toLowerCase();
    if (type === "charge" || type === "refund") {
      const lines = (t.orderGid && byOrder.get(t.orderGid)) || [];
      const { parts, remainder } = split(t.amountCents, type === "refund" ? refundWeights(lines) : lines.map(lineAmount));
      lines.forEach((l, i) => {
        const bucket = l.variantId ? (input.categories.get(l.variantId) ?? null) : null;
        const accountId = l.variantId ? (input.accounts.get(l.variantId) ?? null) : (input.customItemsAccountId ?? null);
        add("income", bucket, parts[i], accountId);
      });
      add(lines.length ? "charge_remainder" : "income", null, remainder);
      add("fees", null, t.netCents - t.amountCents);
    } else {
      add("adjustments", null, t.netCents);
    }
  }

  const lines = [...totals.values()].filter((l) => l.amountCents !== 0);
  const sum = lines.reduce((s, l) => s + l.amountCents, 0);
  if (sum !== input.payoutNetCents) {
    throw new Error(`deposit lines sum to ${sum}, payout net is ${input.payoutNetCents}`);
  }
  return lines;
}
