/**
 * @jest-environment node
 *
 * addHouseholdLead refuses a new lead in a DENIED household, and leaves an existing
 * lead's re-save there a no-op rather than a refusal.
 */

import type { TxClient } from "@/lib/db-client";
import { addHouseholdLead, HouseholdLeadDeniedError } from "@/lib/household/leads";

jest.mock("@/lib/prisma", () => ({ __esModule: true, default: {} }));

const HOUSEHOLD_ID = 7;

function deniedTx(person: { isHouseholdLead: boolean }) {
    const tx = {
        $queryRaw: jest.fn(async (sql: TemplateStringsArray) =>
            sql.join("?").includes('"OrgMembership"') ? [{ status: "DENIED" }] : []),
        person: {
            findUnique: jest.fn().mockResolvedValue({ ...person, householdId: HOUSEHOLD_ID, dateOfBirth: null }),
            count: jest.fn().mockResolvedValue(1),
            update: jest.fn(),
        },
    };
    return { tx, client: tx as unknown as TxClient };
}

test("an existing lead of a DENIED household is a no-op", async () => {
    const { tx, client } = deniedTx({ isHouseholdLead: true });
    await expect(addHouseholdLead(client, HOUSEHOLD_ID, 4)).resolves.toEqual({ created: false });
    expect(tx.person.update).not.toHaveBeenCalled();
});

test("a new lead of a DENIED household is refused", async () => {
    const { tx, client } = deniedTx({ isHouseholdLead: false });
    await expect(addHouseholdLead(client, HOUSEHOLD_ID, 4)).rejects.toBeInstanceOf(HouseholdLeadDeniedError);
    expect(tx.person.update).not.toHaveBeenCalled();
});
