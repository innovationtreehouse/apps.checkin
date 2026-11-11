import { isRecheckPolicySet } from "@/lib/membership/bgRecheckPolicy";

describe("isRecheckPolicySet", () => {
    it("is unset at 0, below 0, null, undefined and NaN", () => {
        for (const months of [0, -3, null, undefined, NaN]) expect(isRecheckPolicySet(months)).toBe(false);
    });

    it("is set at any positive number of months", () => {
        expect(isRecheckPolicySet(1)).toBe(true);
        expect(isRecheckPolicySet(29)).toBe(true);
    });
});
