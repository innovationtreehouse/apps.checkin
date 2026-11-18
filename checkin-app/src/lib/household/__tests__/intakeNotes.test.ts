import { withoutIntakeNoteKeys } from "@/lib/household/intakeNotes";

describe("withoutIntakeNoteKeys", () => {
    it("removes intake-note keys at any depth and keeps everything else", () => {
        const note = "volunteer only";
        expect(withoutIntakeNoteKeys({
            household: { name: "H", intakeNotes: note },
            processes: [{ id: 1, intakeNoteSnapshot: note }],
            note: "kept",
        })).toEqual({ household: { name: "H" }, processes: [{ id: 1 }], note: "kept" });
        expect(withoutIntakeNoteKeys(null)).toBeNull();
    });
});
