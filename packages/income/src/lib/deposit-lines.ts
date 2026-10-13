import type { MirrorBalanceTxn, MirrorOrderLine } from "../contract";

/**
 * Logical account a deposit line books to; the create path maps each to a configured
 * QuickBooks account. `income` carries the item's bucket, or null for organization level.
 * The mirror has no per-order tax or shipping, so both land in `charge_remainder` together
 * with the rounding left over from splitting a charge across its lines.
 */
export type DepositAccount = "income" | "charge_remainder" | "fees" | "adjustments";

export interface DepositLine {
  account: DepositAccount;
  budgetOwnerId: number | null;
  amountCents: number;
}

export interface DepositLineInput {
  payoutNetCents: number;
  txns: MirrorBalanceTxn[];
  orderLines: MirrorOrderLine[];
  /** variantId → budget-owner bucket id. Unmapped variants book at organization level. */
  categories: ReadonlyMap<string, number>;
}

const lineAmount = (l: MirrorOrderLine) => l.priceCents * l.quantity - l.discountCents;

/**
 * Split `amount` (any sign) across `lines`: each line gets its own amount when the total covers
 * them all, otherwise its proportional share, rounded toward zero. Returns the per-line parts
 * and what is left for organization level.
 */
function split(amount: number, lines: MirrorOrderLine[]): { parts: number[]; remainder: number } {
  const sign = Math.sign(amount);
  const abs = Math.abs(amount);
  const amounts = lines.map((l) => Math.max(0, lineAmount(l)));
  const total = amounts.reduce((s, a) => s + a, 0);
  if (total === 0) return { parts: amounts.map(() => 0), remainder: amount };
  const parts = amounts.map((a) => sign * (abs >= total ? a : Math.floor((abs * a) / total)));
  return { parts, remainder: amount - parts.reduce((s, p) => s + p, 0) };
}

/**
 * Build the lines of a deposit the app creates for one payout. Charges and refunds split
 * across their order's lines by line amount and book to each line's bucket; tax, shipping
 * and rounding book at organization level; each transaction's fee (net − amount) books to
 * fees; every other transaction type books whole to adjustments. Lines sum to the payout net.
 */
export function buildDepositLines(input: DepositLineInput): DepositLine[] {
  const byOrder = new Map<string, MirrorOrderLine[]>();
  for (const l of input.orderLines) byOrder.set(l.orderGid, [...(byOrder.get(l.orderGid) ?? []), l]);

  const totals = new Map<string, DepositLine>();
  const add = (account: DepositAccount, budgetOwnerId: number | null, amountCents: number) => {
    if (amountCents === 0) return;
    const key = `${account}:${budgetOwnerId ?? "org"}`;
    const line = totals.get(key) ?? { account, budgetOwnerId, amountCents: 0 };
    line.amountCents += amountCents;
    totals.set(key, line);
  };

  for (const t of input.txns) {
    const type = t.type.toLowerCase();
    if (type === "charge" || type === "refund") {
      const lines = (t.orderGid && byOrder.get(t.orderGid)) || [];
      const { parts, remainder } = split(t.amountCents, lines);
      lines.forEach((l, i) => {
        const bucket = l.variantId ? (input.categories.get(l.variantId) ?? null) : null;
        add("income", bucket, parts[i]);
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
