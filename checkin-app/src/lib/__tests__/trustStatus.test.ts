/**
 * @jest-environment node
 */
import type { DbClient } from "@/lib/db-client";
import { trustStatus } from "@/lib/roles";

const NOTHING = { roles: [], budgetOwnerTreasurerships: [], programsLed: [], instancesLed: [], toolStatuses: [] };

function dbReturning(person: unknown) {
    return { person: { findUnique: jest.fn().mockResolvedValue(person) } } as unknown as DbClient;
}

describe("trustStatus", () => {
    it("is false for someone holding nothing, and for nobody", async () => {
        expect(await trustStatus(dbReturning(NOTHING), 1)).toEqual({ isTrusted: false, roles: [] });
        expect(await trustStatus(dbReturning(null), 1)).toEqual({ isTrusted: false, roles: [] });
    });

    it.each([
        [{ roles: [{ role: "INVENTORY_MANAGER" }] }, "INVENTORY_MANAGER"],
        [{ budgetOwnerTreasurerships: [{ budgetOwnerId: 1 }] }, "BUCKET_TREASURER"],
        [{ programsLed: [{ id: 1 }] }, "PROGRAM_LEADER"],
        [{ instancesLed: [{ id: 1 }] }, "PROGRAM_LEADER"],
        [{ toolStatuses: [{ toolId: 1 }] }, "TOOL_CERTIFIER"],
    ])("names the role behind %j", async (held, role) => {
        expect(await trustStatus(dbReturning({ ...NOTHING, ...held }), 1)).toEqual({ isTrusted: true, roles: [role] });
    });

    it("counts only the top tool level as a certifier", async () => {
        const db = dbReturning(NOTHING);
        await trustStatus(db, 1);
        const { select } = (db.person.findUnique as jest.Mock).mock.calls[0][0];
        expect(select.toolStatuses.where).toEqual({ level: "MAY_CERTIFY_OTHERS" });
    });
});
