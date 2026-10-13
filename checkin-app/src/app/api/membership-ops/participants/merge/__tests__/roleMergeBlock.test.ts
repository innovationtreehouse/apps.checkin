import { roleMergeBlock } from "../membershipGuard";

describe("roleMergeBlock", () => {
    const board = { isBoardMember: true };
    const sysadminOnly = { isBoardMember: false };

    it("allows a merge that moves no roles, whoever the actor is", () => {
        expect(roleMergeBlock(null, [], ["BOARD"], "DENIED")).toBeNull();
    });

    it("refuses to move roles without a session actor", () => {
        expect(roleMergeBlock(null, ["KEYHOLDER"], [], "NONE")?.status).toBe(403);
    });

    it("lets a sysadmin who is not on the board move non-board roles", () => {
        expect(roleMergeBlock(sysadminOnly, ["KEYHOLDER", "SYSADMIN"], [], "NONE")).toBeNull();
    });

    it("refuses a non-board actor when BOARD moves, even as a duplicate", () => {
        expect(roleMergeBlock(sysadminOnly, ["BOARD"], ["BOARD"], "ACTIVE")?.status).toBe(403);
    });

    it("refuses BOARD landing on a DENIED keeper household", () => {
        expect(roleMergeBlock(board, ["BOARD"], [], "DENIED")?.status).toBe(409);
    });

    it("allows BOARD onto a DENIED keeper that already holds it", () => {
        expect(roleMergeBlock(board, ["BOARD"], ["BOARD"], "DENIED")).toBeNull();
    });
});
