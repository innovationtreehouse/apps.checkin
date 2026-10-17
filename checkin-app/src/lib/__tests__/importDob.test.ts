import { parseImportDob } from "@/lib/importDob";

describe("parseImportDob", () => {
    // Pins the preview/commit drift: an all-digit DOB is an Excel serial, not a
    // year. "33239" must become 1991-01-01, NOT Jan 1 of year 33239 — otherwise
    // preview classifies the person as a youth while commit imports an adult.
    it("parses an Excel-serial DOB to the same date as the commit path", () => {
        const d = parseImportDob("33239")!;
        expect(d.getUTCFullYear()).toBe(1991);
        expect(d.getUTCMonth()).toBe(0);
        expect(d.getUTCDate()).toBe(1);
    });

    it("parses an ISO date string", () => {
        const d = parseImportDob("1991-01-01")!;
        expect(d.getUTCFullYear()).toBe(1991);
    });

    it("returns undefined for empty/unparseable input", () => {
        expect(parseImportDob("")).toBeUndefined();
        expect(parseImportDob(undefined)).toBeUndefined();
        expect(parseImportDob("not a date")).toBeUndefined();
    });

    // F11: a DOB is a calendar date, so every branch stores UTC midnight — same
    // convention as the interactive writers (normalizeAdultDob).
    describe("UTC-midnight convention west of UTC", () => {
        const realTz = process.env.TZ;
        beforeAll(() => { process.env.TZ = "America/Chicago"; });
        afterAll(() => { if (realTz === undefined) delete process.env.TZ; else process.env.TZ = realTz; });

        it("pins a non-ISO spreadsheet date to UTC midnight of the written day", () => {
            // "5/4/1990" parses as LOCAL midnight; unpinned it stores 1990-05-04T05:00Z
            // in Chicago, and any other zone's rows disagree with it.
            expect(parseImportDob("5/4/1990")!.toISOString()).toBe("1990-05-04T00:00:00.000Z");
        });

        it("pins a bare ISO date to UTC midnight", () => {
            expect(parseImportDob("1991-01-01")!.toISOString()).toBe("1991-01-01T00:00:00.000Z");
        });

        it("truncates a fractional Excel serial's time of day", () => {
            // 33239.75 is 1991-01-01 18:00 — the day is the DOB, the time is noise.
            expect(parseImportDob("33239.75")!.toISOString()).toBe("1991-01-01T00:00:00.000Z");
        });
    });
});
