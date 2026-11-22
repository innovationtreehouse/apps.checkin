/**
 * @jest-environment node
 *
 * Promoting a household lead settles the household's background check after the
 * promotion commits; a person who is already a lead settles nothing.
 */

import type { NextRequest } from "next/server";
import { getServerSession } from "next-auth/next";
import prisma from "@/lib/prisma";
import { addHouseholdLead } from "@/lib/household/leads";
import { settleAfterEvent } from "@/lib/membership/settleHouseholdBg";
import { POST } from "@/app/api/household/lead/route";

jest.mock("next-auth/next", () => ({ getServerSession: jest.fn() }));
jest.mock("@/lib/auth-options", () => ({ authOptions: {} }));
jest.mock("@/lib/logger", () => ({ logger: { error: jest.fn() }, logBackendError: jest.fn() }));
jest.mock("@/lib/auditActor", () => ({ ...jest.requireActual("@/lib/auditActor"), recordAudit: jest.fn() }));
jest.mock("@/lib/membership/settleHouseholdBg", () => ({ settleAfterEvent: jest.fn().mockResolvedValue([]) }));
jest.mock("@/lib/household/leads", () => ({ ...jest.requireActual("@/lib/household/leads"), addHouseholdLead: jest.fn() }));
jest.mock("@/lib/prisma", () => ({
    __esModule: true,
    default: {
        person: { findUnique: jest.fn() },
        $transaction: jest.fn((fn: (t: unknown) => unknown) => fn({})),
    },
}));

const ME = 1;
const OTHER = 3;
const HOUSEHOLD = 10;

const promote = () => POST(new Request("http://localhost/api/household/lead", {
    method: "POST",
    body: JSON.stringify({ participantId: OTHER }),
}) as unknown as NextRequest);

beforeEach(() => {
    jest.clearAllMocks();
    (getServerSession as jest.Mock).mockResolvedValue({ user: { id: ME } });
    (prisma.person.findUnique as jest.Mock).mockImplementation(({ where }) => Promise.resolve(where.id === ME
        ? { isSysadmin: false, isBoardMember: false, isHouseholdLead: true, householdId: HOUSEHOLD }
        : { id: OTHER, householdId: HOUSEHOLD }));
});

describe("POST /api/household/lead — settles the household", () => {
    it("settles the household once the promotion commits", async () => {
        jest.mocked(addHouseholdLead).mockResolvedValue({ created: true });
        expect((await promote()).status).toBe(200);
        expect(settleAfterEvent).toHaveBeenCalledWith(HOUSEHOLD, "lead promotion", {}, { personId: OTHER });
    });

    it("settles nothing when the person is already a lead", async () => {
        jest.mocked(addHouseholdLead).mockResolvedValue({ created: false });
        expect((await promote()).status).toBe(200);
        expect(settleAfterEvent).not.toHaveBeenCalled();
    });
});
