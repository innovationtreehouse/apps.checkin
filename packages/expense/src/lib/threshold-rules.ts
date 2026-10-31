// Who may move each setting which way. Shared by the settings service and the settings page.
import type { ExpenseSettings } from "../contract";

/**
 * Which change to each threshold loosens a control. "up": a higher value; a lower one tightens.
 * A capital review threshold of 0 sends every expense to review, so 0 is its tightest value.
 * FINANCE may tighten freely, and loosen only up to the policy value; past that, or for a
 * threshold with no policy value, loosening is the Board's. A `boardOnly` threshold is the
 * Board's to change in either direction; an `either` setting is finance's or the Board's in either
 * direction. Every field must be listed here.
 */
export const THRESHOLD_RULES: Record<keyof ExpenseSettings, { loosens: "up"; policyCents?: number; boardOnly?: true; either?: true }> = {
  boardReviewTotalCents: { loosens: "up", policyCents: 200_000 },
  everydayTotalLimitCents: { loosens: "up", policyCents: 50_000, boardOnly: true },
  everydayItemLimitCents: { loosens: "up", policyCents: 25_000, boardOnly: true },
  capitalTotalThresholdCents: { loosens: "up" },
  capitalLineItemThresholdCents: { loosens: "up" },
  qbMatchWindowDays: { loosens: "up", either: true },
  qbMaxCreatesPerRun: { loosens: "up" },
  qbMaxCreatesPerDay: { loosens: "up" },
};

/** Fields in the change that only the Board may make. */
export function boardOnlyChanges(current: ExpenseSettings, changes: Partial<ExpenseSettings>): (keyof ExpenseSettings)[] {
  return (Object.keys(changes) as (keyof ExpenseSettings)[]).filter((field) => {
    const to = changes[field]!;
    if (THRESHOLD_RULES[field].either) return false;
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
