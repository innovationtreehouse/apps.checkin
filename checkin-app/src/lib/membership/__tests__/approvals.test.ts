import { clearingApprovals } from "@/lib/membership/approvals";

describe("clearingApprovals", () => {
    it("counts only a household's approvals that name its settled subject", () => {
        // A legacy unnamed approval plus one named approval: two recorded, one counted.
        expect(clearingApprovals([{ result: "APPROVE", subjectPersonId: null }, { result: "APPROVE", subjectPersonId: 7 }], false)).toBe(1);
        // Two reviewers who named different adults: the first name settles it.
        expect(clearingApprovals([{ subjectPersonId: 7 }, { subjectPersonId: 8 }], false)).toBe(1);
        expect(clearingApprovals([{ subjectPersonId: 7 }, { subjectPersonId: 7 }], false)).toBe(2);
        expect(clearingApprovals([{ subjectPersonId: null }], false)).toBe(0);
    });

    it("counts every approval on a PERSON_BG", () => {
        expect(clearingApprovals([{ result: "APPROVE", subjectPersonId: null }, { result: "APPROVE", subjectPersonId: null }], true)).toBe(2);
        expect(clearingApprovals([{ result: "REJECT", subjectPersonId: null }], true)).toBe(0);
    });
});
