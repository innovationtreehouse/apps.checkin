import { recentProgramWhere } from "../filters";

describe("recentProgramWhere", () => {
    it("bounds the program window by the org's calendar day, not the UTC instant", () => {
        // 9 PM in Chicago on 18 Nov is already 19 Nov in UTC.
        const where = recentProgramWhere(new Date("2026-11-19T03:00:00Z"));
        expect(where).toEqual({
            AND: [
                { endAt: { gte: new Date("2025-11-18T00:00:00.000Z") } },
                { startAt: { lte: new Date("2026-11-18T00:00:00.000Z") } },
            ],
        });
    });
});
