/**
 * @jest-environment node
 *
 * On the profile, a non-lead in a household with a lead cannot change their own
 * date of birth or over-25 declaration. A lead, a household with no lead, and
 * someone with no household are unchanged.
 */

import type { NextRequest } from "next/server";
import { getServerSession } from "next-auth/next";
import prisma from "@/lib/prisma";
import { PATCH } from "@/app/api/profile/route";
import { AGE_LEAD_ONLY_REFUSAL, AGE_REQUIRED_REFUSAL } from "@/lib/person/adultDob";

jest.mock("next-auth/next", () => ({ getServerSession: jest.fn() }));
jest.mock("@/lib/auth-options", () => ({ authOptions: {} }));
jest.mock("@/lib/logger", () => ({ logger: { error: jest.fn() } }));
jest.mock("@/lib/getFullAttendance", () => ({ invalidateAttendanceCache: jest.fn() }));
jest.mock("@/lib/membership/boardAlerts", () => ({ notifyBoardOfYouthLeads: jest.fn() }));
const tx = {
    person: { update: jest.fn() },
    auditLog: { create: jest.fn() },
};
jest.mock("@/lib/prisma", () => ({
    __esModule: true,
    default: {
        person: { findUnique: jest.fn(), findMany: jest.fn() },
        $transaction: jest.fn((fn: (t: unknown) => unknown) => fn(tx)),
    },
}));

const mockSession = getServerSession as jest.Mock;
const findMe = prisma.person.findUnique as jest.Mock;
const findLeads = prisma.person.findMany as jest.Mock;
const update = tx.person.update;

const ME = 3;
const LEAD = 1;

function patch(body: Record<string, unknown>) {
    return PATCH(new Request("http://localhost/api/profile", { method: "PATCH", body: JSON.stringify(body) }) as unknown as NextRequest);
}

beforeEach(() => {
    jest.clearAllMocks();
    mockSession.mockResolvedValue({ user: { id: ME } });
    findMe.mockResolvedValue({ dateOfBirth: null, isDeclaredAdult: false, householdId: 10 });
    findLeads.mockResolvedValue([{ id: LEAD }]);
    update.mockResolvedValue({});
});

describe("PATCH /api/profile — own age", () => {
    it.each([
        ["a date of birth", { dob: "1990-01-01", over25: false }],
        ["an over-25 declaration", { dob: null, over25: true }],
    ])("refuses a non-lead setting %s in a household with a lead, writing nothing", async (_label, fields) => {
        const res = await patch({ name: "Me", ...fields });
        expect(res.status).toBe(403);
        expect((await res.json()).error).toBe(AGE_LEAD_ONLY_REFUSAL);
        expect(update).not.toHaveBeenCalled();
    });

    it("lets a non-lead save other fields while their age is resent unchanged", async () => {
        findMe.mockResolvedValue({ dateOfBirth: null, isDeclaredAdult: true, householdId: 10 });
        expect((await patch({ name: "Me", dob: null, over25: true })).status).toBe(200);
        expect(update).toHaveBeenCalled();
    });

    it("lets a non-lead save when the age fields are left out", async () => {
        expect((await patch({ name: "Me" })).status).toBe(200);
    });

    it("lets a lead set their own date of birth", async () => {
        findLeads.mockResolvedValue([{ id: ME }]);
        expect((await patch({ dob: "1990-01-01", over25: false })).status).toBe(200);
    });

    it("lets a member of a household with no lead set their own date of birth", async () => {
        findLeads.mockResolvedValue([]);
        expect((await patch({ dob: "1990-01-01", over25: false })).status).toBe(200);
    });

    it("leaves someone with no household unchanged", async () => {
        findMe.mockResolvedValue({ dateOfBirth: null, isDeclaredAdult: false, householdId: null });
        expect((await patch({ dob: "1990-01-01", over25: false })).status).toBe(200);
        expect(findLeads).not.toHaveBeenCalled();
    });
});

describe("PATCH /api/profile — an age must stay on file", () => {
    beforeEach(() => findLeads.mockResolvedValue([{ id: ME }]));

    it("refuses a save that leaves no date of birth and no over-25 declaration, writing nothing", async () => {
        const res = await patch({ dob: null, over25: false });
        expect(res.status).toBe(400);
        expect((await res.json()).error).toBe(AGE_REQUIRED_REFUSAL);
        expect(update).not.toHaveBeenCalled();
    });

    it("refuses clearing an over-25 declaration on file", async () => {
        findMe.mockResolvedValue({ dateOfBirth: null, isDeclaredAdult: true, householdId: 10 });
        expect((await patch({ dob: "", over25: false })).status).toBe(400);
    });

    it("lets someone with no age on file declare over 25", async () => {
        expect((await patch({ dob: null, over25: true })).status).toBe(200);
        expect(update.mock.calls[0][0].data.isDeclaredAdult).toBe(true);
    });
});
