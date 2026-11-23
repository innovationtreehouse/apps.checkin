import { bgFreshThreshold, bgValidUntilBoundary, nextBoundary } from "@/lib/membership/renewal";
import { isRecheckPolicySet } from "@/lib/membership/bgRecheckPolicy";
import { orgCalendarDay } from "@/lib/time";

/** Where a person's background check stands against the board's recheck policy, as a family sees it. */
export type BgStatus = "VALID" | "EXPIRES_BEFORE_NEXT_YEAR" | "EXPIRED";

type Settings = { orgMembershipYearBoundary: Date | null; bgRecheckMonths: number };

/**
 * A person's background-check status at `now`, or null when there is nothing to
 * show: the recheck interval or the membership-year boundary is unset, or no check
 * is on file.
 *
 * - VALID: the check still counts at the upcoming membership-year boundary.
 * - EXPIRED: the check no longer counts today (same rule as supervision).
 * - EXPIRES_BEFORE_NEXT_YEAR: it counts today but not at the upcoming boundary.
 */
export function bgStatus(lastBackgroundCheck: Date | null, settings: Settings, now: Date): BgStatus | null {
    const { orgMembershipYearBoundary: boundary, bgRecheckMonths } = settings;
    if (!lastBackgroundCheck || !boundary || !isRecheckPolicySet(bgRecheckMonths)) return null;
    const threshold = bgFreshThreshold(nextBoundary(boundary, now), bgRecheckMonths);
    if (threshold && lastBackgroundCheck.getTime() >= threshold.getTime()) return "VALID";
    const validUntil = bgValidUntilBoundary(lastBackgroundCheck, settings);
    return validUntil && validUntil.getTime() >= orgCalendarDay(now).getTime() ? "EXPIRES_BEFORE_NEXT_YEAR" : "EXPIRED";
}
