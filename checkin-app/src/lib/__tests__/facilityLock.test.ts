import { FACILITY_ADVISORY_CLASS, FACILITY_ADVISORY_KEY, lockFacility } from "@/lib/facilityLock";

describe("lockFacility", () => {
    it("takes the two-arg advisory lock (independent of per-person 1-arg locks)", async () => {
        const executeRaw = jest.fn().mockResolvedValue(undefined);
        await lockFacility({ $executeRaw: executeRaw } as never);
        expect(executeRaw).toHaveBeenCalledTimes(1);
        const strings = executeRaw.mock.calls[0][0] as TemplateStringsArray;
        expect(strings.join("")).toContain("pg_advisory_xact_lock");
        expect(executeRaw.mock.calls[0].slice(1)).toEqual([
            FACILITY_ADVISORY_CLASS,
            FACILITY_ADVISORY_KEY,
        ]);
    });
});
