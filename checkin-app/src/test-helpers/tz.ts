/**
 * Pin the process timezone to a zone west of UTC for the duration of a suite.
 *
 * Calendar-date fields read back at UTC midnight; rendering one through a
 * wall-clock zone west of UTC yields the previous day. These tests only prove
 * that if the process is actually in such a zone — CI runs in UTC, where the
 * bug is invisible. See docs/conventions.md, "A day is not a moment".
 *
 * A jest lifecycle wrapper, not a React hook — call it inside a describe block.
 */
export function pinTimezone(tz = "America/Chicago") {
    const original = process.env.TZ;
    beforeAll(() => { process.env.TZ = tz; });
    afterAll(() => { process.env.TZ = original; });
}
