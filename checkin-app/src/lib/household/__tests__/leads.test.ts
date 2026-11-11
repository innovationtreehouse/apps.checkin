/**
 * @jest-environment node
 *
 * Unit check for the shared household-lead ownership helper. Mocks
 * prisma the way participantPiiMinimization.test.ts does, so this runs in the
 * default (non-integration) suite with no live DB.
 */

import prisma from "@/lib/prisma";
import { leadHousehold } from "@/lib/household/leads";

jest.mock("@/lib/prisma", () => ({
    __esModule: true,
    default: { person: { findUnique: jest.fn() } },
}));

const mockFind = (prisma.person.findUnique as jest.Mock);

beforeEach(() => jest.clearAllMocks());

test("a lead of their household gets the householdId", async () => {
    mockFind.mockResolvedValue({
        id: 1,
        householdId: 42,
        isSysadmin: false,
        isHouseholdLead: true,
    });
    expect(await leadHousehold(1)).toBe(42);
});

test("a non-lead gets the {error,status} 403 object", async () => {
    mockFind.mockResolvedValue({
        id: 2,
        householdId: 42,
        isSysadmin: false,
        isHouseholdLead: false, // a member who is not a lead
    });
    expect(await leadHousehold(2)).toEqual({
        error: "Only household leads can manage emergency contacts.",
        status: 403,
    });
});

test("no household gets the {error,status} 400 object", async () => {
    mockFind.mockResolvedValue({ id: 3, householdId: null, isSysadmin: false, isHouseholdLead: false });
    expect(await leadHousehold(3)).toEqual({
        error: "You must create a household first.",
        status: 400,
    });
});
