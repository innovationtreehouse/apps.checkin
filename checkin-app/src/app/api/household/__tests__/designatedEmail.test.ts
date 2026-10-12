/**
 * @jest-environment node
 *
 * Volunteer designations are confirmed by the Board onto a household, so
 * member-side email writes refuse any address that canonically matches a stored
 * designation.
 */

import type { NextRequest } from "next/server";
import { getServerSession } from "next-auth/next";
import prisma from "@/lib/prisma";
import { PATCH as householdPATCH } from "@/app/api/household/route";
import { PATCH as memberPATCH } from "@/app/api/household/member/route";

jest.mock("next-auth/next", () => ({ getServerSession: jest.fn() }));
jest.mock("@/lib/auth-options", () => ({ authOptions: {} }));
jest.mock("@/lib/logger", () => ({ logger: { error: jest.fn() } }));
jest.mock("@/lib/getFullAttendance", () => ({ invalidateAttendanceCache: jest.fn() }));
jest.mock("@/lib/emergencyContacts/service", () => ({ reconcileAndWarn: jest.fn().mockResolvedValue(null) }));
jest.mock("@/lib/person/mintId", () => ({ mintPersonId: jest.fn().mockResolvedValue(99) }));
jest.mock("@/lib/household/leads", () => ({
    ...jest.requireActual("@/lib/household/leads"),
    householdLeadship: jest.fn(),
}));

const tx = {
    person: { update: jest.fn(), create: jest.fn(), findUnique: jest.fn() },
    auditLog: { create: jest.fn() },
};
jest.mock("@/lib/prisma", () => ({
    __esModule: true,
    default: {
        person: { findUnique: jest.fn() },
        volunteerDesignation: { findMany: jest.fn() },
        boardSettings: { findUnique: jest.fn() },
        $transaction: jest.fn((fn: (t: unknown) => unknown) => fn(tx)),
    },
}));

const { householdLeadship } = jest.requireMock("@/lib/household/leads") as { householdLeadship: jest.Mock };
const mockSession = getServerSession as jest.Mock;
const findPerson = prisma.person.findUnique as jest.Mock;
const findDesignations = prisma.volunteerDesignation.findMany as jest.Mock;
const findSettings = prisma.boardSettings.findUnique as jest.Mock;

const REFUSAL = "That email address can't be added here. To use it, email the board at board@example.org.";

const LEAD = 1;
const KID = 3;

function call(handler: typeof memberPATCH, path: string, body: Record<string, unknown>) {
    return handler(new Request(`http://localhost${path}`, { method: "PATCH", body: JSON.stringify(body) }) as unknown as NextRequest);
}

beforeEach(() => {
    jest.clearAllMocks();
    mockSession.mockResolvedValue({ user: { id: LEAD, email: "lead@example.com" } });
    householdLeadship.mockResolvedValue({ householdId: 10, canManage: true });
    findDesignations.mockResolvedValue([{ email: "volunteer@gmail.com" }]);
    findSettings.mockResolvedValue({ emailFromAddress: null, emailReplyToAddress: "Board <board@example.org>" });
    tx.person.update.mockImplementation(({ where }) => Promise.resolve({ id: where.id }));
    tx.person.create.mockImplementation(({ data }) => Promise.resolve({ id: data.id, email: data.email ?? null, name: data.name }));
});

describe("PATCH /api/household/member — designated address", () => {
    beforeEach(() => findPerson.mockResolvedValue({ id: KID, householdId: 10, _count: { accounts: 0 } }));

    it("refuses an address that canonically matches a designation", async () => {
        const res = await call(memberPATCH, "/api/household/member", { participantId: KID, email: "Volun.teer+x@googlemail.com" });
        expect(res.status).toBe(400);
        expect((await res.json()).error).toBe(REFUSAL);
        expect(tx.person.update).not.toHaveBeenCalled();
    });

    it("still saves an undesignated address", async () => {
        const res = await call(memberPATCH, "/api/household/member", { participantId: KID, email: "kid@example.com" });
        expect(res.status).toBe(200);
        expect(tx.person.update).toHaveBeenCalled();
    });

    it("still clears an email", async () => {
        const res = await call(memberPATCH, "/api/household/member", { participantId: KID, email: "" });
        expect(res.status).toBe(200);
    });
});

describe("PATCH /api/household — adding a member with a designated address", () => {
    const member = { memberName: "New Person", memberOver25: true };

    it("refuses an address that canonically matches a designation", async () => {
        const res = await call(householdPATCH, "/api/household", { ...member, memberEmail: "VOLUNTEER@gmail.com" });
        expect(res.status).toBe(400);
        expect((await res.json()).error).toBe(REFUSAL);
        expect(tx.person.create).not.toHaveBeenCalled();
    });

    it("still adds a member with an undesignated address", async () => {
        const res = await call(householdPATCH, "/api/household", { ...member, memberEmail: "new@example.com" });
        expect(res.status).toBe(200);
        expect(tx.person.create).toHaveBeenCalled();
    });
});
