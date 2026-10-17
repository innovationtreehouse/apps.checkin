/**
 * Seed default and offline fallback only — NOT the display zone. The organisation's
 * display zone is the editable `AppSettings.timezone` (lib/appSettings.ts), which the
 * server resolves per request and passes to the formatters below.
 */
export const APP_TIMEZONE = 'America/Chicago';

/** An instant, in any of the shapes the formatters accept. */
export type DateInput = Date | string | number | null | undefined;

/**
 * Options for the instant formatters. `timeZone` is required so the organisation's
 * configured zone is always passed in rather than read from ambient state: client
 * components get it from `useOrgTime()`, server callers from `resolveDisplayTimezone()`.
 */
export type ZonedOptions = Intl.DateTimeFormatOptions & { timeZone: string };

/**
 * Returns a localized date string for an instant, in the given timezone
 */
export function formatDate(date: DateInput, options: ZonedOptions): string {
    if (!date) return '';
    return new Date(date).toLocaleDateString(undefined, options);
}

/**
 * Returns a localized time string in the given timezone
 */
export function formatTime(date: DateInput, options: ZonedOptions): string {
    if (!date) return '';
    return new Date(date).toLocaleTimeString(undefined, options);
}

/**
 * Returns a combined localized date and time string in the given timezone
 */
export function formatDateTime(date: DateInput, options: ZonedOptions): string {
    if (!date) return '';
    return new Date(date).toLocaleString(undefined, options);
}

/**
 * Coarse "how long ago" for freshness lines ("just now", "12 min ago", "3 hr ago",
 * "2 d ago"). No timezone involved — it's a difference, not a wall-clock reading.
 * Deliberately coarse: it answers "is this stale?", not "exactly when?" — pair it
 * with formatDateTime when the precise instant matters.
 */
export function relTime(when: string | Date, now: Date | number = Date.now()): string {
    const ms = new Date(now).getTime() - new Date(when).getTime();
    const min = Math.floor(ms / 60000);
    if (min < 1) return "just now";
    if (min < 60) return `${min} min ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr} hr ago`;
    return `${Math.floor(hr / 24)} d ago`;
}

/**
 * Visit time range for display: "1:35 PM-2:19 PM (44 minutes)" once departed,
 * or "1:35 PM-" while still active (no end time, no length — too dynamic).
 * Times are shown without seconds.
 */
export function formatVisitRange(
    arrived: DateInput,
    departed: DateInput,
    timeZone: string,
): string {
    if (!arrived) return '';
    const hm: ZonedOptions = { timeZone, hour: 'numeric', minute: '2-digit' };
    const start = formatTime(arrived, hm);
    if (!departed) return `${start}-`;
    const mins = Math.round((new Date(departed).getTime() - new Date(arrived).getTime()) / 60000);
    return `${start}-${formatTime(departed, hm)} (${mins} minute${mins === 1 ? '' : 's'})`;
}

/**
 * Format a date as a value for an <input type="datetime-local"> (yyyy-MM-ddTHH:mm).
 *
 * NOTE: datetime-local is inherently local, so this uses the BROWSER's timezone — matching the
 * inline `getTime() - getTimezoneOffset()*60000` conversions it replaces. It deliberately does
 * NOT use APP_TIMEZONE; switching to that would change the displayed value.
 */
export function toDatetimeLocal(date: Date | string | number | null | undefined): string {
    if (!date) return '';
    const d = new Date(date);
    if (Number.isNaN(d.getTime())) return '';
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

/**
 * Parse an <input type="datetime-local"> value into a UTC ISO string. Inverse of toDatetimeLocal.
 * Returns '' for empty/invalid input.
 */
export function fromDatetimeLocal(value: string | null | undefined): string {
    if (!value) return '';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    return d.toISOString();
}

/**
 * Format a calendar-date field (program dates, DOB, memberSince — `@db.Date`
 * columns, which Prisma reads back at UTC midnight) UTC-pinned, so the stored
 * calendar day renders unshifted in every zone. Counterpart to formatDate,
 * which is for instants. See docs/conventions.md, "A day is not a moment".
 */
export function formatDateOnly(date: Date | string | number | null | undefined, options?: Intl.DateTimeFormatOptions): string {
    if (!date) return '';
    return new Date(date).toLocaleDateString(undefined, { timeZone: 'UTC', ...options });
}

/**
 * Parse an <input type="date"> value ("yyyy-MM-dd") into the calendar-date
 * storage convention: UTC midnight (what `new Date` does to a bare date).
 * The single write-side seam for calendar dates; the `@db.Date` columns behind
 * it truncate anything timed that slips past. A value already carrying a time
 * parses as-is. See docs/conventions.md, "A day is not a moment".
 */
export function parseDateOnly(value: string | null | undefined): Date | null {
    return value ? new Date(value) : null;
}

/** Numeric y/m/d parts of an instant in the organisation's zone. */
const ORG_DAY_PARTS = new Intl.DateTimeFormat('en-US', {
    timeZone: APP_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
});

/**
 * The calendar day an instant falls on in the organisation's zone, as a UTC-midnight
 * Date — the storage shape of every `@db.Date` column. The sanctioned way to take a
 * day from a moment: the zone is named rather than inherited from the process.
 * See docs/conventions.md, "A day is not a moment".
 *
 * Pinned to APP_TIMEZONE, not the configured display zone, so a server age gate and
 * the browser cannot disagree about who is 18. ponytail: a settings-aware variant has
 * to be async (the zone comes from the database), so it waits until the org moves zones.
 */
export function orgCalendarDay(instant: Date | string | number = new Date()): Date {
    const p = Object.fromEntries(
        ORG_DAY_PARTS.formatToParts(new Date(instant)).map(({ type, value }) => [type, value]),
    );
    return new Date(`${p.year}-${p.month}-${p.day}T00:00:00.000Z`);
}

/**
 * Returns the calendar age in whole years for the given DOB, decremented if
 * the birthday hasn't happened yet as of `asOf`. Canonical implementation — use
 * this everywhere instead of inline epoch-diff age math.
 *
 * `asOf` defaults to today's calendar day in the organisation's zone, so a birthday
 * rolls over at local midnight rather than at UTC midnight — 7 PM the evening before,
 * which would grant adult status early. Program age gates pass the program's start
 * date so the bound is judged as-of when the program begins, not when the person
 * happens to register.
 *
 * Both sides are read via getUTC* because both are calendar dates stored at UTC
 * midnight — local fields off those instants read a day early west of UTC. A caller
 * passing `asOf` must therefore pass a day, not a moment.
 */
export function calculateAge(dob: Date | string, asOf: Date | string = orgCalendarDay()): number {
    const birthDate = new Date(dob);
    const today = new Date(asOf);
    let age = today.getUTCFullYear() - birthDate.getUTCFullYear();
    const m = today.getUTCMonth() - birthDate.getUTCMonth();
    if (m < 0 || (m === 0 && today.getUTCDate() < birthDate.getUTCDate())) age--;
    return age;
}

/**
 * Returns true if the person with the given DOB is under 18 years old (youth).
 * Canonical implementation — use this everywhere instead of inline age checks.
 *
 * Unknown (null/undefined) DOB resolves to `unknownIs`, default 'adult': UI and
 * household-lead callers rely on that (a null-DOB member stays promotable to
 * lead, blank forms don't show youth fields). Safety checks must pass
 * `{ unknownIs: 'youth' }` so missing data fails closed (#300).
 */
export function isYouth(
    dob: Date | string | null | undefined,
    opts?: { unknownIs?: 'youth' | 'adult' },
): boolean {
    if (!dob) return (opts?.unknownIs ?? 'adult') === 'youth';
    return calculateAge(dob) < 18;
}
