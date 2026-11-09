import { disputedCheckBlock, type CheckSide } from "../guard";

describe("disputedCheckBlock", () => {
    const clean: CheckSide = { disputing: [], openReviews: 0 };
    const disputed: CheckSide = { disputing: [{ id: 41 }], openReviews: 1 };
    const pending: CheckSide = { disputing: [], openReviews: 1 };

    it("refuses a disputed record a newer date is carried onto, naming the review", () => {
        const error = disputedCheckBlock(disputed, clean, true);
        expect(error).toContain("#41");
        expect(error).toContain("Board");
    });

    it("refuses when the merged-away record is the disputed one and its date is carried", () => {
        expect(disputedCheckBlock(clean, disputed, true)).toContain("#41");
    });

    it("allows a disputed record when no date is carried and no review moves onto it", () => {
        expect(disputedCheckBlock(disputed, clean, false)).toBeNull();
    });

    it("refuses a second review moved onto a disputed keeper", () => {
        expect(disputedCheckBlock(disputed, pending, false)).toContain("#41");
    });

    it("refuses a disputed review moved onto a keeper that has a review of its own", () => {
        expect(disputedCheckBlock(pending, disputed, false)).toContain("#41");
    });

    it("refuses a review moved onto a keeper disputed by a row that names nobody", () => {
        expect(disputedCheckBlock({ disputing: [{ id: 7 }], openReviews: 0 }, pending, false)).toContain("#7");
    });

    it("allows a disputed record's only review to move onto a keeper with none", () => {
        expect(disputedCheckBlock(clean, disputed, false)).toBeNull();
    });

    it("allows any change when neither record is disputed", () => {
        expect(disputedCheckBlock(pending, pending, true)).toBeNull();
    });
});
