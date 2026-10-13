/**
 * @jest-environment node
 *
 * Designating an address that belongs to a person already in the app shows the
 * Board that person's household, and only the Board's explicit confirm sets the
 * household's OrgMembership.isVolunteer (audited). An address with no match is
 * stored as a designation (the dues preload).
 */

import type { NextRequest } from "next/server";
import { getServerSession } from "next-auth/next";
import prisma from "@/lib/prisma";
import { POST } from "@/app/api/settings/membership/volunteer-designations/route";

jest.mock("next-auth/next", () => ({ getServerSession: jest.fn() }));
jest.mock("@/lib/auth-options", () => ({ authOptions: {} }));
jest.mock("@/lib/membership/selfGrantGuard", () => ({ refuseSelfGrant: jest.fn().mockResolvedValue(false), SELF_GRANT_REFUSAL_MESSAGE: "refused" }));

const designationDelegate = { findMany: jest.fn(), create: jest.fn() };
const tx = {
    orgMembership: { update: jest.fn() },
    auditLog: { create: jest.fn() },
    volunteerDesignation: designationDelegate,
};
jest.mock("@/lib/prisma", () => ({
    __esModule: true,
    default: {
        // A getter: jest hoists this factory above the const it reads.
        get volunteerDesignation() { return designationDelegate; },
        person: { findMany: jest.fn() },
        $transaction: jest.fn((fn: (t: unknown) => unknown) => fn(tx)),
    },
}));

const mockSession = getServerSession as jest.Mock;
const findDesignations = prisma.volunteerDesignation.findMany as jest.Mock;
const createDesignation = prisma.volunteerDesignation.create as jest.Mock;
const findPeople = prisma.person.findMany as jest.Mock;

const BOARD = 7;
const person = (email: string, householdId: number, orgMembership: { id: number; isVolunteer: boolean } | null) => ({
    name: "Pat Example",
    email,
    household: { id: householdId, name: "Example Household", orgMembership },
});

function post(body: Record<string, unknown>) {
    return POST(new Request("http://localhost/api/settings/membership/volunteer-designations", {
        method: "POST",
        body: JSON.stringify(body),
    }) as unknown as NextRequest);
}

beforeEach(() => {
    jest.clearAllMocks();
    mockSession.mockResolvedValue({ user: { id: BOARD, isBoardMember: true } });
    findDesignations.mockResolvedValue([]);
    findPeople.mockResolvedValue([]);
    createDesignation.mockImplementation(({ data }) => Promise.resolve({ id: 1, ...data }));
});

describe("POST volunteer-designations — existing person", () => {
    beforeEach(() => findPeople.mockResolvedValue([person("pat.example@gmail.com", 20, { id: 30, isVolunteer: false })]));

    it("shows the canonical match and writes nothing without a confirm", async () => {
        const res = await post({ email: "PatExample+x@googlemail.com" });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
            requiresConfirmation: true,
            match: { personName: "Pat Example", householdId: 20, householdName: "Example Household", isVolunteer: false },
        });
        expect(tx.orgMembership.update).not.toHaveBeenCalled();
        expect(createDesignation).not.toHaveBeenCalled();
    });

    it("sets the household's isVolunteer on confirm, audited, and stores no designation", async () => {
        const res = await post({ email: "patexample@gmail.com", confirmHouseholdId: 20 });
        expect(res.status).toBe(200);
        expect(tx.orgMembership.update).toHaveBeenCalledWith({ where: { id: 30 }, data: { isVolunteer: true } });
        expect(tx.auditLog.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                actorId: BOARD,
                action: "EDIT",
                tableName: "OrgMembership",
                affectedEntityId: 30,
                secondaryAffectedEntity: 20,
                oldData: { isVolunteer: false },
                newData: { isVolunteer: true },
            }),
        });
        expect(createDesignation).not.toHaveBeenCalled();
    });

    it("refuses a confirm for a household the address does not match", async () => {
        const res = await post({ email: "patexample@gmail.com", confirmHouseholdId: 21 });
        expect(res.status).toBe(409);
        expect(tx.orgMembership.update).not.toHaveBeenCalled();
        expect(createDesignation).not.toHaveBeenCalled();
    });

    it("refuses an address that matches people in more than one household", async () => {
        findPeople.mockResolvedValue([
            person("pat.example@gmail.com", 20, { id: 30, isVolunteer: false }),
            person("patexample@gmail.com", 22, { id: 32, isVolunteer: false }),
        ]);
        const res = await post({ email: "patexample@gmail.com", confirmHouseholdId: 20 });
        expect(res.status).toBe(409);
        expect(tx.orgMembership.update).not.toHaveBeenCalled();
        expect(createDesignation).not.toHaveBeenCalled();
    });
});

describe("POST volunteer-designations — no household membership to set", () => {
    it("stores a designation when nobody in the app has the address", async () => {
        const res = await post({ email: "newcomer@example.com" });
        expect(res.status).toBe(201);
        expect(createDesignation).toHaveBeenCalledWith({ data: { email: "newcomer@example.com", createdById: BOARD } });
        expect(tx.orgMembership.update).not.toHaveBeenCalled();
    });

    it("stores a designation when the matching household has no membership yet", async () => {
        findPeople.mockResolvedValue([person("pat@example.com", 20, null)]);
        const res = await post({ email: "pat@example.com" });
        expect(res.status).toBe(201);
        expect(createDesignation).toHaveBeenCalled();
        expect(tx.orgMembership.update).not.toHaveBeenCalled();
    });
});
