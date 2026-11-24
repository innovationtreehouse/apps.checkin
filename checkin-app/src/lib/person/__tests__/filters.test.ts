import { recentProgramWhere } from "../filters";
import { calendarDayIn } from "@/lib/time";

describe("recentProgramWhere", () => {
    it("bounds the program window by the day it is given", () => {
        expect(recentProgramWhere(new Date("2026-11-18T00:00:00.000Z"))).toEqual({
            AND: [
                { endAt: { gte: new Date("2025-11-18T00:00:00.000Z") } },
                { startAt: { lte: new Date("2026-11-18T00:00:00.000Z") } },
            ],
        });
    });

    it("takes a program starting on the 12th as running from the org zone's 12th", () => {
        // 12:30 AM on the 12th in New York, 11:30 PM on the 11th in Chicago.
        const instant = "2026-10-12T04:30:00Z";
        const startBound = (zone: string) =>
            (recentProgramWhere(calendarDayIn(instant, zone)).AND as { startAt?: { lte: Date } }[])[1].startAt!.lte.toISOString();
        expect(startBound("America/New_York")).toBe("2026-10-12T00:00:00.000Z");
        expect(startBound("America/Chicago")).toBe("2026-10-11T00:00:00.000Z");
    });
});
