// Who may move each money threshold which way. Shared by the settings service and the settings page.
import type { ExpenseSettings } from "../contract";

/**
 * Raising a threshold loosens its control; lowering it tightens.
 * A capital review threshold of 0 sends every expense to review, so 0 is its tightest value.
 * FINANCE may tighten freely, and loosen only up to the policy value; past that, or for a
 * threshold with no policy value, loosening is the Board's. A `boardOnly` threshold is the
 * Board's to change in either direction. Every field must be listed here.
 */
export const THRESHOLD_RULES: Record<keyof ExpenseSettings, { policyCents?: number; boardOnly?: true }> = {
  boardReviewTotalCents: { policyCents: 200_000 },
  everydayTotalLimitCents: { policyCents: 50_000, boardOnly: true },
  everydayItemLimitCents: { policyCents: 25_000, boardOnly: true },
  capitalTotalThresholdCents: {},
  capitalLineItemThresholdCents: {},
};

/** Fields in the change that only the Board may make. */
export function boardOnlyChanges(current: ExpenseSettings, changes: Partial<ExpenseSettings>): (keyof ExpenseSettings)[] {
  return (Object.keys(changes) as (keyof ExpenseSettings)[]).filter((field) => {
    const to = changes[field]!;
    if (THRESHOLD_RULES[field].boardOnly) return to !== current[field];
    if (to <= current[field]) return false;
    const { policyCents } = THRESHOLD_RULES[field];
    return policyCents === undefined || to > policyCents;
  });
}

/** The highest value FINANCE may set the field to, or null when it is the Board's in either direction. */
export function financeCeilingCents(field: keyof ExpenseSettings, currentCents: number): number | null {
  const { boardOnly, policyCents } = THRESHOLD_RULES[field];
  if (boardOnly) return null;
  return Math.max(currentCents, policyCents ?? currentCents);
}
