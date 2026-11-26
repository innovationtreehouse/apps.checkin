import { treehouseMergeBlock } from "../guard";

describe("treehouseMergeBlock", () => {
    it("refuses bringing a record from another household into a Treehouse account's household", () => {
        expect(treehouseMergeBlock(true, false)).toMatch(/Treehouse account's household/);
    });

    it("allows a merge within one household, or into an ordinary household", () => {
        expect(treehouseMergeBlock(true, true)).toBeNull();
        expect(treehouseMergeBlock(false, false)).toBeNull();
    });
});
