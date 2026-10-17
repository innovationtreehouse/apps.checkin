/**
 * Parse a date-of-birth cell from a bulk-import spreadsheet.
 *
 * Shared by the import COMMIT and PREVIEW endpoints so the admin approves the
 * same date that gets imported. If these two ever parse differently again, the
 * preview classifies a person differently than the commit (e.g. youth vs adult).
 *
 * xlsx may hand us an Excel serial number (days since 1899-12-30) as a digit
 * string when no bookType is provided, so handle that before falling back to
 * the native Date parser.
 *
 * A DoB is a calendar date, so every branch returns UTC midnight — the same
 * convention the interactive writers use (normalizeAdultDob), and the column is
 * a `date`, which truncates any time that slips through.
 * See docs/conventions.md, "A day is not a moment".
 */
export function parseImportDob(dobString: string | undefined): Date | undefined {
    if (!dobString) return undefined;

    if (/^\d+(\.\d+)?$/.test(dobString)) {
        // Excel serial number. A fractional serial carries a time of day; floor
        // it so the result is the calendar day, not a mid-day instant.
        const serial = Math.floor(parseFloat(dobString));
        return new Date(Date.UTC(1899, 11, 30) + serial * 86400000);
    }

    const d = new Date(dobString);
    if (isNaN(d.getTime())) return undefined;
    // A bare ISO date parses as UTC; every other spreadsheet format ("5/4/1990")
    // parses as LOCAL time and would land a day early west of UTC. Read the
    // calendar fields from whichever zone the string was parsed in, then re-pin.
    return /^\d{4}-\d{2}-\d{2}/.test(dobString.trim())
        ? new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
        : new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
}
