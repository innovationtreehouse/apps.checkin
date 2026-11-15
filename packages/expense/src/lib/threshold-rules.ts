// Who may move each setting which way. Shared by the settings service and the settings page.
import type { ExpenseSettings } from "../contract";

/** The numeric settings; capital review's on/off switch is ruled on separately. */
export type ThresholdField = Exclude<keyof ExpenseSettings, "capitalReviewEnabled">;

/**
 * Raising a threshold loosens its control; lowering it tightens.
 * An unset capital threshold holds every expense at review, so unset is its tightest value, and
 * setting one is loosening it.
 * FINANCE may tighten freely, and loosen only up to the policy value; past that, or for a
 * threshold with no policy value, loosening is the Board's. A `boardOnly` threshold is the
 * Board's to change in either direction; an `either` setting is finance's or the Board's in either
 * direction. Every field must be listed here. Turning capital review off is the Board's; turning it
 * on is finance's or the Board's.
 */
export const THRESHOLD_RULES: Record<ThresholdField, { policyCents?: number; boardOnly?: true; either?: true }> = {
  boardReviewTotalCents: { policyCents: 200_000 },
  everydayTotalLimitCents: { policyCents: 50_000, boardOnly: true },
  everydayItemLimitCents: { policyCents: 25_000, boardOnly: true },
  capitalTotalThresholdCents: {},
  capitalLineItemThresholdCents: {},
  qbMatchWindowDays: { either: true },
  qbMaxCreatesPerRun: {},
  qbMaxCreatesPerDay: {},
};

/** Fields in the change that only the Board may make. */
export function boardOnlyChanges(current: ExpenseSettings, changes: Partial<ExpenseSettings>): (keyof ExpenseSettings)[] {
  return (Object.keys(changes) as (keyof ExpenseSettings)[]).filter((field) => {
    if (field === "capitalReviewEnabled") return current.capitalReviewEnabled && changes.capitalReviewEnabled === false;
    const to = changes[field]!;
    const from = current[field];
    if (THRESHOLD_RULES[field].either) return false;
    if (THRESHOLD_RULES[field].boardOnly) return to !== from;
    if (from !== null && to <= from) return false;
    const { policyCents } = THRESHOLD_RULES[field];
    return policyCents === undefined || to > policyCents;
  });
}

/** The highest value FINANCE may set the field to, or null when it is the Board's in either direction. */
export function financeCeilingCents(field: ThresholdField, currentCents: number | null): number | null {
  const { boardOnly, policyCents } = THRESHOLD_RULES[field];
  if (boardOnly || currentCents === null) return null;
  return Math.max(currentCents, policyCents ?? currentCents);
}
