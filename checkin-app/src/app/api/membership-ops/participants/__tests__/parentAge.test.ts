/**
 * @jest-environment node
 *
 * A staff add that names a parent who is not on file creates that parent, so it must give the
 * parent's age (a date of birth or over 25). A parent already on file needs none.
 */

import type { NextRequest } from "next/server";
import { getServerSession } from "next-auth/next";
import prisma from "@/lib/prisma";
import { POST } from "@/app/api/membership-ops/participants/route";
import { AGE_REQUIRED_REFUSAL } from "@/lib/person/adultDob";

jest.mock("next-auth/next", () => ({ getServerSession: jest.fn() }));
jest.mock("@/lib/auth-options", () => ({ authOptions: {} }));
jest.mock("@/lib/logger", () => ({ logBackendError: jest.fn(), logger: { error: jest.fn() } }));
jest.mock("@/lib/prisma", () => ({
    __esModule: true,
    default: {
        person: { findUnique: jest.fn(), create: jest.fn() },
        $transaction: jest.fn(),
    },
}));

const findPerson = prisma.person.findUnique as jest.Mock;

function post(body: Record<string, unknown>) {
    return POST(new Request("http://localhost/api/membership-ops/participants", { method: "POST", body: JSON.stringify(body) }) as unknown as NextRequest);
}

const CHILD = { name: "Kid", dob: "2015-01-01", parentEmail: "new.parent@example.com", parentName: "New Parent" };

beforeEach(() => {
    jest.clearAllMocks();
    (getServerSession as jest.Mock).mockResolvedValue({ user: { id: 1, isSysadmin: true } });
    findPerson.mockResolvedValue(null);
});

describe("POST /api/membership-ops/participants — a new parent's age", () => {
    it("refuses a parent not on file with neither a date of birth nor over 25, creating nothing", async () => {
        const res = await post(CHILD);
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual(expect.objectContaining({ error: AGE_REQUIRED_REFUSAL, fields: ["parentDob"] }));
        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(prisma.person.create).not.toHaveBeenCalled();
    });

    it("asks nothing more of a parent already on file", async () => {
        findPerson.mockResolvedValue({ id: 7, householdId: 70 });
        const res = await post(CHILD);
        expect(res.status).not.toBe(400);
    });
});
