/**
 * @jest-environment node
 *
 * A youth cannot set their own phone through onboarding, as on the profile
 * route; an unknown date of birth reads as adult. A lead's household emergency
 * contact is household data, not the youth's own profile.
 */

import type { NextRequest } from "next/server";
import { getServerSession } from "next-auth/next";
import prisma from "@/lib/prisma";
import { POST } from "@/app/api/profile/onboarding/route";

jest.mock("next-auth/next", () => ({ getServerSession: jest.fn() }));
jest.mock("@/lib/auth-options", () => ({ authOptions: {} }));
jest.mock("@/lib/logger", () => ({ logger: { error: jest.fn() } }));
jest.mock("@/lib/emergencyContacts/service", () => ({
    ...jest.requireActual("@/lib/emergencyContacts/service"),
    upsertPrimaryContact: jest.fn(),
}));
jest.mock("@/lib/prisma", () => ({
    __esModule: true,
    default: {
        person: { findUnique: jest.fn(), update: jest.fn() },
    },
}));

const mockSession = getServerSession as jest.Mock;
const findPerson = prisma.person.findUnique as jest.Mock;
const updatePerson = prisma.person.update as jest.Mock;
const { upsertPrimaryContact } = jest.requireMock("@/lib/emergencyContacts/service") as { upsertPrimaryContact: jest.Mock };

const ME = 1;
const YOUTH_DOB = new Date(new Date().getFullYear() - 14, 0, 1);
const ADULT_DOB = new Date(new Date().getFullYear() - 22, 0, 1);

function post(body: Record<string, unknown>) {
    return POST(new Request("http://localhost/api/profile/onboarding", {
        method: "POST",
        body: JSON.stringify(body),
    }) as unknown as NextRequest);
}

beforeEach(() => {
    jest.clearAllMocks();
    mockSession.mockResolvedValue({ user: { id: ME } });
});

describe("POST /api/profile/onboarding — youth self-edit", () => {
    it("refuses a youth setting their own phone, writing nothing", async () => {
        findPerson.mockResolvedValue({ householdId: 10, isHouseholdLead: false, dateOfBirth: YOUTH_DOB });
        const res = await post({ phone: "5125551234" });
        expect(res.status).toBe(403);
        expect((await res.json()).error).toBe("Youth profiles are read-only.");
        expect(updatePerson).not.toHaveBeenCalled();
    });

    it.each([
        ["an adult", ADULT_DOB],
        ["an unknown date of birth, read as adult", null],
    ])("stores the phone for %s", async (_label, dateOfBirth) => {
        findPerson.mockResolvedValue({ householdId: 10, isHouseholdLead: false, dateOfBirth });
        const res = await post({ phone: "5125551234" });
        expect(res.status).toBe(200);
        expect(updatePerson).toHaveBeenCalledWith(expect.objectContaining({ where: { id: ME } }));
    });

    it("still saves a youth lead's household emergency contact", async () => {
        findPerson.mockResolvedValue({ householdId: 10, isHouseholdLead: true, dateOfBirth: YOUTH_DOB });
        const res = await post({ emergencyContactName: "Pat Doe", emergencyContactPhone: "5125559876" });
        expect(res.status).toBe(200);
        expect(upsertPrimaryContact).toHaveBeenCalledWith(prisma, 10, expect.objectContaining({ name: "Pat Doe" }));
        expect(updatePerson).not.toHaveBeenCalled();
    });
});
