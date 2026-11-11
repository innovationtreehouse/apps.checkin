import { fromZonedTime, toZonedTime } from "date-fns-tz";

// Shared by facility/trends and facility/corrections, so both bucket on the same
// org-timezone logic. formatPeriodLabel/getHoursBetween/getLookbackMonths stay in
// trends — nothing else needs them.
export type PeriodType = "week" | "month" | "quarter" | "year";

// Period boundaries are the org's wall clock, not the server's: toZonedTime
// shifts an instant so its local calendar fields read as the org zone's, and
// fromZonedTime converts such a wall clock back to an instant.
export function getPeriodStart(date: Date, period: PeriodType, timeZone: string): Date {
    const d = toZonedTime(date, timeZone);
    if (period === "week") {
        d.setDate(d.getDate() - d.getDay());
    } else if (period === "month") {
        d.setDate(1);
    } else if (period === "quarter") {
        d.setMonth(Math.floor(d.getMonth() / 3) * 3, 1);
    } else {
        d.setMonth(0, 1);
    }
    d.setHours(0, 0, 0, 0);
    return fromZonedTime(d, timeZone);
}
