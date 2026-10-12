/**
 * @jest-environment node
 *
 * A household member with a linked sign-in keeps their sign-in address: the
 * household member edit refuses any `email` field for them and says how to change
 * it. Members without a sign-in stay editable.
 */

import type { NextRequest } from "next/server";
import { getServerSession } from "next-auth/next";
import prisma from "@/lib/prisma";
import { PATCH } from "@/app/api/household/member/route";
import { signInEmailHelp } from "@/lib/person/signInEmail";

jest.mock("next-auth/next", () => ({ getServerSession: jest.fn() }));
jest.mock("@/lib/auth-options", () => ({ authOptions: {} }));
jest.mock("@/lib/logger", () => ({ logger: { error: jest.fn() } }));
jest.mock("@/lib/getFullAttendance", () => ({ invalidateAttendanceCache: jest.fn() }));
jest.mock("@/lib/emergencyContacts/service", () => ({ reconcileAndWarn: jest.fn().mockResolvedValue(null) }));
jest.mock("@/lib/household/leads", () => ({
    ...jest.requireActual("@/lib/household/leads"),
    householdLeadship: jest.fn(),
}));

const tx = {
    person: { update: jest.fn(), findUnique: jest.fn() },
    auditLog: { create: jest.fn() },
};
jest.mock("@/lib/prisma", () => ({
    __esModule: true,
    default: {
        person: { findUnique: jest.fn() },
        boardSettings: { findUnique: jest.fn() },
        $transaction: jest.fn((fn: (t: unknown) => unknown) => fn(tx)),
    },
}));

const { householdLeadship } = jest.requireMock("@/lib/household/leads") as { householdLeadship: jest.Mock };
const mockSession = getServerSession as jest.Mock;
const findPerson = prisma.person.findUnique as jest.Mock;
const findSettings = prisma.boardSettings.findUnique as jest.Mock;

const LEAD = 1;
const CO_LEAD = 2;
const KID = 3;

function target(id: number, accounts: number) {
    return { id, householdId: 10, email: `p${id}@example.com`, _count: { accounts } };
}

function patch(body: Record<string, unknown>) {
    return PATCH(new Request("http://localhost/api/household/member", {
        method: "PATCH",
        body: JSON.stringify(body),
    }) as unknown as NextRequest);
}

beforeEach(() => {
    jest.clearAllMocks();
    mockSession.mockResolvedValue({ user: { id: LEAD } });
    householdLeadship.mockResolvedValue({ householdId: 10, canManage: true });
    findSettings.mockResolvedValue({ emailFromAddress: null, emailReplyToAddress: "Board <board@example.org>" });
    tx.person.update.mockImplementation(({ where }) => Promise.resolve({ id: where.id }));
});

describe("PATCH /api/household/member — sign-in email lock", () => {
    it("refuses a signed-in member editing their own email, with how to change it", async () => {
        findPerson.mockResolvedValue(target(LEAD, 1));
        const res = await patch({ participantId: LEAD, email: "new@example.com" });
        expect(res.status).toBe(400);
        expect((await res.json()).error).toBe(
            "This is the address you sign in with. To change it, email the board at board@example.org.",
        );
        expect(tx.person.update).not.toHaveBeenCalled();
    });

    it("refuses a lead editing a signed-in co-lead's email", async () => {
        findPerson.mockResolvedValue(target(CO_LEAD, 1));
        const res = await patch({ participantId: CO_LEAD, email: "new@example.com" });
        expect(res.status).toBe(400);
        expect(tx.person.update).not.toHaveBeenCalled();
    });

    it("refuses an unchanged email field on a signed-in record", async () => {
        findPerson.mockResolvedValue(target(CO_LEAD, 1));
        const res = await patch({ participantId: CO_LEAD, name: "Co Lead", email: `p${CO_LEAD}@example.com` });
        expect(res.status).toBe(400);
        expect(tx.person.update).not.toHaveBeenCalled();
    });

    it("says to contact the board when no reply-to address is set", async () => {
        findSettings.mockResolvedValue({ emailFromAddress: null, emailReplyToAddress: null });
        findPerson.mockResolvedValue(target(LEAD, 1));
        const res = await patch({ participantId: LEAD, email: "new@example.com" });
        expect((await res.json()).error).toBe(signInEmailHelp(null));
        expect(signInEmailHelp(null)).toBe("This is the address you sign in with. To change it, contact the board.");
    });

    it("saves a signed-in member's other fields when email is left out", async () => {
        findPerson.mockResolvedValue(target(CO_LEAD, 1));
        const res = await patch({ participantId: CO_LEAD, name: "Co Lead" });
        expect(res.status).toBe(200);
        expect(tx.person.update.mock.calls[0][0].data.email).toBeUndefined();
    });

    it("still edits the email of a member without a sign-in", async () => {
        findPerson.mockResolvedValue(target(KID, 0));
        const res = await patch({ participantId: KID, email: "Kid@Example.com" });
        expect(res.status).toBe(200);
        expect(tx.person.update.mock.calls[0][0].data.email).toBe("kid@example.com");
    });
});
