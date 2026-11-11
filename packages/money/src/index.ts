/**
 * Money is represented everywhere as INTEGER MINOR UNITS (cents).
 * Never use floats for money. All conversion and arithmetic goes through here.
 *
 * Display convention: money stays integer cents from DB → API → client and is
 * converted to a string exactly ONCE, at the render call, via `formatCents`.
 * There is no dollars-in display formatter — that was the source of the cents/100×
 * bug class (a boundary inventing a dollar-named field and forgetting the ÷100).
 */

/**
 * Single parse contract for both entry points: Number() semantics (rejects trailing
 * garbage like "12.5x") plus explicit empty/blank-string rejection (blank ≠ $0.00).
 * Returns integer cents, or NaN for invalid input — callers decide throw vs. null.
 *
 * Rounding: Math.round(n * 100) rounds a float product, so "1.005" → 100 (because
 * 1.005 * 100 === 100.4999…). toFixed(4) collapses that ~1e-13 representation error
 * before the final round, giving 101. Robust across the cent-safe integer range; no
 * big-decimal library needed.
 * ponytail: toFixed(4) round; swap to big-decimal only if a real amount exceeds the
 * cent-safe range (> ~MAX_SAFE_INTEGER/100 dollars) and breaks it — none found.
 */
function parseDollarsToCents(value: string | number): number {
  if (typeof value === "string" && value.trim() === "") return NaN;
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n)) return NaN;
  return Math.round(Number((n * 100).toFixed(4)));
}

/** Parse a dollar string/number (e.g. "123.45", 123.45) into integer cents. Throws on blank/NaN/Infinity. */
export function dollarsToCents(value: string | number): number {
  const cents = parseDollarsToCents(value);
  if (Number.isNaN(cents)) throw new Error(`Invalid monetary value: ${value}`);
  return cents;
}

/** Parse a dollar string into integer cents. Returns null for empty/missing/invalid input. */
export function dollarsToCentsOrNull(value: string | undefined): number | null {
  if (value === undefined) return null;
  const cents = parseDollarsToCents(value);
  return Number.isNaN(cents) ? null : cents;
}

/** Integer cents as a dollar number for an external API's wire format (e.g. QuickBooks); never for display. */
export function centsToDollars(cents: number): number {
  if (!Number.isSafeInteger(cents)) throw new Error(`Cents must be a safe integer, got ${cents}`);
  return cents / 100;
}

/** Integer cents as a plain decimal string for a wire format that wants "12.50"; never for display. */
export function centsToDecimalString(cents: number): string {
  return centsToDollars(cents).toFixed(2);
}

/** Sum integer-cent amounts. Inputs must already be integer cents. */
export function sumCents(...amounts: number[]): number {
  return amounts.reduce((acc, n) => acc + n, 0);
}

/**
 * Split `totalCents` across parts in proportion to `weights`, in whole cents that sum to
 * `totalCents` exactly. Each part takes the floor of its exact share; the leftover cents go one
 * each to the largest fractional remainders, a tie to the larger weight, then the earlier part.
 * Either sign works for the total and the weights. Weights that sum to zero (all-zero
 * included) split the total equally; a caller that must refuse that case checks before calling.
 * Arithmetic is BigInt so shares stay exact past the safe-integer product range.
 */
export function allocateCents(totalCents: number, weights: readonly number[]): number[] {
  for (const n of [totalCents, ...weights]) {
    if (!Number.isSafeInteger(n)) throw new Error(`Allocation amounts must be safe integers, got ${n}`);
  }
  if (weights.length === 0) {
    if (totalCents !== 0) throw new Error(`Cannot allocate ${totalCents} cents across no parts`);
    return [];
  }
  const zero = BigInt(0);
  const one = BigInt(1);
  const sum = weights.reduce((s, w) => s + BigInt(w), zero);
  const ws = sum === zero ? weights.map(() => one) : weights.map(BigInt);
  // A positive denominator keeps BigInt division a floor and remainders in [0, denom).
  const denom = sum === zero ? BigInt(weights.length) : sum < zero ? -sum : sum;
  const total = sum < zero ? -BigInt(totalCents) : BigInt(totalCents);
  const shares = ws.map((w, i) => {
    const num = total * w;
    let floor = num / denom;
    if (num % denom !== zero && num < zero) floor -= one;
    return { i, floor, rem: num - floor * denom, w };
  });
  // Each floor drops less than one cent, so fewer than weights.length cents are left over.
  let leftover = Number(BigInt(totalCents) - shares.reduce((s, p) => s + p.floor, zero));
  const byFraction = [...shares].sort((a, b) =>
    a.rem !== b.rem ? (b.rem > a.rem ? 1 : -1) : a.w !== b.w ? (b.w > a.w ? 1 : -1) : a.i - b.i,
  );
  for (const p of byFraction) {
    if (leftover <= 0) break;
    p.floor += one;
    leftover -= 1;
  }
  return shares.map((p) => Number(p.floor));
}

// Floating-point noise in quantity × unit price, not a real fraction of a cent.
const NOISE = 1e-6;

/**
 * How far a line's total may sit from quantity × unit price and still be that line: under a cent
 * per unit, and under a cent for a quantity below one. A store may round or truncate the unit
 * price (3 × $3.33 for $10.00 is 3 × $3.333…; $4.99 may be $4.989) or the line total
 * (0.37 × $4.99 is 184.63¢, printed $1.84 or $1.85).
 */
function lineRoundingAllowance(quantity: number): number {
  return Math.max(1, quantity);
}

/** Whether a line's total is quantity × unit price, rounded or truncated; a difference of the full allowance does not agree. */
export function lineRoundingAgrees(totalCents: number, quantity: number, unitPriceCents: number): boolean {
  return Math.abs(totalCents - quantity * unitPriceCents) < lineRoundingAllowance(quantity) - NOISE;
}

/**
 * Canonical money display formatter. Input is INTEGER CENTS; output is a localized
 * currency string with thousands grouping and the currency's symbol, e.g.
 * `formatCents(1234567)` → "$12,345.67", `formatCents(1234567, "EUR")` → "€12,345.67".
 * Returns "—" for null/undefined. This is the ONLY money display function in the fleet.
 */
export function formatCents(cents: number | null | undefined, currency = "USD"): string {
  if (cents == null) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency || "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    // Adding 0 turns -0 into 0, which Intl would print as "-$0.00".
  }).format(cents / 100 + 0);
}

/** @deprecated Use `formatCents`. Retained as an identical alias for existing call sites. */
export const formatUSD = formatCents;
