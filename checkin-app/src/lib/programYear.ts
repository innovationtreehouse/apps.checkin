// Pure, prisma-free helpers for the finance-ops board's "next year" flag, so a
// client component can import them (lib/membership/renewal.nextBoundary pulls in
// prisma and can't cross into the browser bundle). Kept dependency-free and
// unit-tested in __tests__/programYear.test.ts.

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

/** A membership year's name: 2026 → "2026-2027". */
export function membershipYearLabel(year: number): string {
    return `${year}-${year + 1}`;
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
