import { mayManageKeyVolunteers, orderRoleChanges } from "@/lib/roles";
import type { DbClient } from "@/lib/db-client";

function dbWithBoardCount(count: number): DbClient {
    return { personRole: { count: jest.fn(async () => count) } } as unknown as DbClient;
}

describe("orderRoleChanges", () => {
    it("revokes the gated roles before Key Volunteer, and grants Key Volunteer first", () => {
        expect(orderRoleChanges({ isKeyVolunteer: false, isBackgroundCheckReviewer: false, isBoardMember: false, isOperations: true })).toEqual([
            ["isBoardMember", false],
            ["isBackgroundCheckReviewer", false],
            ["isKeyVolunteer", false],
            ["isOperations", true],
        ]);
        expect(orderRoleChanges({ isFinance: true, isKeyVolunteer: true })).toEqual([
            ["isKeyVolunteer", true],
            ["isFinance", true],
        ]);
    });

    it("leaves out flags not in the request", () => {
        expect(orderRoleChanges({})).toEqual([]);
    });
});

describe("mayManageKeyVolunteers", () => {
    it("allows a board member", async () => {
        expect(await mayManageKeyVolunteers(dbWithBoardCount(3), { isBoardMember: true })).toBe(true);
    });

    it("allows a sysadmin only while no board member exists", async () => {
        expect(await mayManageKeyVolunteers(dbWithBoardCount(0), { isSysadmin: true })).toBe(true);
        expect(await mayManageKeyVolunteers(dbWithBoardCount(1), { isSysadmin: true })).toBe(false);
    });

    it("refuses anyone else", async () => {
        expect(await mayManageKeyVolunteers(dbWithBoardCount(0), {})).toBe(false);
    });
});
