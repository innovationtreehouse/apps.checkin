import { LIVE_KEYHOLDER } from "@/lib/visit/filters";

/** The household statuses the shared keyholder filter leaves out, read from the filter itself. */
function excludedStatuses(): unknown {
    const not = LIVE_KEYHOLDER.NOT as { household?: { orgMembership?: { status?: { in?: unknown } } } } | undefined;
    return not?.household?.orgMembership?.status?.in;
}

describe("LIVE_KEYHOLDER", () => {
    it.each(["DENIED", "REVOKED"])("holds no keyholder whose household is %s", (status) => {
        expect(excludedStatuses()).toEqual(expect.arrayContaining([status]));
    });

    it("keeps a keyholder whose household has no membership or an active one", () => {
        expect(excludedStatuses()).toEqual(expect.not.arrayContaining(["NONE"]));
        expect(excludedStatuses()).toEqual(expect.not.arrayContaining(["ACTIVE"]));
    });
});
