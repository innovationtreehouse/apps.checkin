import { bringsOthersIntoKeeperHousehold } from "../guard";

describe("bringsOthersIntoKeeperHousehold", () => {
    it("is true for a record from another household that holds other people", () => {
        expect(bringsOthersIntoKeeperHousehold({ sameHousehold: false, liveOthers: 1 })).toBe(true);
    });

    it("is false for a record alone in its household: the account's own duplicate", () => {
        expect(bringsOthersIntoKeeperHousehold({ sameHousehold: false, liveOthers: 0 })).toBe(false);
    });

    it("is false within one household", () => {
        expect(bringsOthersIntoKeeperHousehold({ sameHousehold: true, liveOthers: 2 })).toBe(false);
    });
});
