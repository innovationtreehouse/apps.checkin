// Pure, prisma-free membership-year helpers, so a client component can import them
// (lib/membership/renewal pulls in prisma and can't cross into the browser bundle).
// Kept dependency-free and unit-tested in __tests__/programYear.test.ts.

/** Next occurrence (>= now) of the membership-year boundary's month/day. */
export function nextBoundary(boundary: Date, now: Date): Date {
    const b = new Date(Date.UTC(now.getUTCFullYear(), boundary.getUTCMonth(), boundary.getUTCDate()));
    if (b.getTime() < now.getTime()) b.setUTCFullYear(b.getUTCFullYear() + 1);
    return b;
}

/**
 * A scholarship/payment-plan request "lands next year" when its program starts
 * on/after the next membership-year cutoff. No cutoff configured, or no program
 * start date → unknown (false). ISO strings in (as they arrive over the wire).
 */
export function landsNextYear(startAt: string | null, cutoff: string | null, now: Date = new Date()): boolean {
    if (!startAt || !cutoff) return false;
    return new Date(startAt).getTime() >= nextBoundary(new Date(cutoff), now).getTime();
}

/**
 * The two member-year start dates an age report is judged against: `next` is the
 * upcoming boundary, `current` the one the org is living in (a year earlier).
 */
export function memberYearStarts(boundary: Date, now: Date = new Date()): { current: Date; next: Date } {
    const next = nextBoundary(boundary, now);
    const current = new Date(next);
    current.setUTCFullYear(current.getUTCFullYear() - 1);
    return { current, next };
}

/**
 * Latest date of birth that still makes someone `years` old as of `asOf` — the
 * SQL-side form of calculateAge(dob, asOf) >= years, so an age filter can run in
 * the query instead of over every loaded row.
 */
export function birthCutoff(asOf: Date, years = 18): Date {
    return new Date(Date.UTC(asOf.getUTCFullYear() - years, asOf.getUTCMonth(), asOf.getUTCDate()));
}

/** The membership year a date falls in, named by the year its opening boundary is in. */
export function membershipYearOf(boundary: Date, date: Date): number {
    const year = date.getUTCFullYear();
    const opens = Date.UTC(year, boundary.getUTCMonth(), boundary.getUTCDate());
    return date.getTime() >= opens ? year : year - 1;
}

/** The boundary that opens membership year `year`. */
export function membershipYearStart(boundary: Date, year: number): Date {
    return new Date(Date.UTC(year, boundary.getUTCMonth(), boundary.getUTCDate()));
}

/** A membership year's name: 2026 → "2026-2027". */
export function membershipYearLabel(year: number): string {
    return `${year}-${year + 1}`;
}

/** The years the membership settings hold a variant slot for: the year in progress, then the coming year. */
export function variantSlotYears(boundary: Date, now: Date): [number, number] {
    const inProgress = membershipYearOf(boundary, now);
    return [inProgress, inProgress + 1];
}

/**
 * The membership years a program's dates touch, earliest first. An end date on
 * the boundary counts in the year that boundary closes, because coverage of a
 * year reaches its closing boundary inclusively.
 */
export function programYearsTouched(boundary: Date, startAt: Date, endAt: Date): number[] {
    const first = membershipYearOf(boundary, startAt);
    const last = Math.max(first, membershipYearOf(boundary, new Date(endAt.getTime() - 1)));
    return Array.from({ length: last - first + 1 }, (_, i) => first + i);
}

/** How many months before the boundary the renewal window opens. */
export const RENEWAL_LEAD_MONTHS = 2;

/** `date` moved back `months` calendar months, UTC, with JS month rollover. */
export function monthsBefore(date: Date, months: number): Date {
    const d = new Date(date);
    d.setUTCMonth(d.getUTCMonth() - months);
    return d;
}

/**
 * From a configured boundary date, the next boundary occurrence and whether `now`
 * sits inside the renewal lead window before it. Pure; the single source of the
 * "are we in renewal season" calc.
 */
export function renewalWindow(configuredBoundary: Date, now: Date): { boundary: Date; windowStart: Date; inSeason: boolean } {
    const boundary = nextBoundary(configuredBoundary, now);
    const windowStart = monthsBefore(boundary, RENEWAL_LEAD_MONTHS);
    return { boundary, windowStart, inSeason: now.getTime() >= windowStart.getTime() };
}

/**
 * The membership year now in effect: its label, the boundary that opened it
 * (`cycleStart`), the boundary that closes it (`cycleEnd`), and the day its renewal
 * window opened (`settledSince`). The year flips
 * at windowStart — the coming year becomes "live" exactly when it becomes renewable
 * and stays live until the next window opens — so in season the live year is the
 * one about to begin, and off season it is the one that began at the last boundary.
 * Drives badge years and every money horizon; pure, from the configured boundary.
 */
export function membershipYearCycle(
    configuredBoundary: Date,
    now: Date,
): { label: string; settledSince: Date; cycleStart: Date; cycleEnd: Date } {
    const { boundary, windowStart, inSeason } = renewalWindow(configuredBoundary, now);
    // Off-season, `boundary` is already next year's, so the live cycle is the one that
    // opened at the previous windowStart.
    const endYear = boundary.getUTCFullYear() + (inSeason ? 1 : 0);
    const settledSince = inSeason
        ? windowStart
        : new Date(Date.UTC(windowStart.getUTCFullYear() - 1, windowStart.getUTCMonth(), windowStart.getUTCDate()));
    const cycleEnd = new Date(Date.UTC(endYear, boundary.getUTCMonth(), boundary.getUTCDate()));
    const cycleStart = new Date(Date.UTC(endYear - 1, boundary.getUTCMonth(), boundary.getUTCDate()));
    return { label: `${endYear - 1}-${endYear}`, settledSince, cycleStart, cycleEnd };
}

/** The live year at `now`, named by the year its opening boundary is in; null with no boundary set. */
export function liveMembershipYear(configuredBoundary: Date | null | undefined, now: Date): number | null {
    return configuredBoundary ? membershipYearCycle(configuredBoundary, now).cycleStart.getUTCFullYear() : null;
}

/**
 * Why a closed household application can't be reopened for its year, or null. Its
 * year is the live year when it was created; once the next year's renewal window
 * opens, Reopen refuses. No boundary set, or a per-person kind: null.
 */
export function reopenYearRefusal(kind: string, createdAt: Date, boundary: Date | null | undefined, now: Date): string | null {
    if (kind !== "INITIAL" && kind !== "RENEWAL") return null;
    const year = liveMembershipYear(boundary, createdAt);
    const live = liveMembershipYear(boundary, now);
    if (year == null || live == null || live <= year) return null;
    const instead = kind === "RENEWAL" ? "use the new renewal" : "start a new application";
    return `This application is for ${membershipYearLabel(year)}. The ${membershipYearLabel(year + 1)} renewal period has started, so it can't be reopened; ${instead}.`;
}

/**
 * Why a payment-plan request for `year` can't be approved, or null: its year has
 * reached its cutoff, the configured boundary date in the following calendar year,
 * by `now`. No boundary set, or no year: null.
 */
export function endedPaymentPlanYearRefusal(year: number | null, boundary: Date | null | undefined, now: Date): string | null {
    if (year == null || !boundary || membershipYearOf(boundary, now) <= year) return null;
    return `This request is for ${membershipYearLabel(year)}, which has ended. Deny it; the family can ask again for the current year.`;
}
