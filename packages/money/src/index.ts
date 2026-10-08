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

/** Sum integer-cent amounts. Inputs must already be integer cents. */
export function sumCents(...amounts: number[]): number {
  return amounts.reduce((acc, n) => acc + n, 0);
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
  }).format(cents / 100);
}

/** @deprecated Use `formatCents`. Retained as an identical alias for existing call sites. */
export const formatUSD = formatCents;
