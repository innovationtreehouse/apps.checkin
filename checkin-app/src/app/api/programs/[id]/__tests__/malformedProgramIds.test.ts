/**
 * @jest-environment node
 */
import type { NextRequest } from "next/server";
import { getServerSession } from "next-auth/next";
import prisma from "@/lib/prisma";
import { GET, PATCH } from "@/app/api/programs/[id]/route";
import { POST as discountCode } from "@/app/api/programs/[id]/discount-code/route";
import { GET as eligibleParticipants } from "@/app/api/programs/[id]/eligible-participants/route";
import { POST as requestPaymentPlan } from "@/app/api/programs/[id]/request-payment-plan/route";
import { POST as syncShopify } from "@/app/api/programs/[id]/sync-shopify/route";

jest.mock("next-auth/next", () => ({ getServerSession: jest.fn() }));
jest.mock("@/lib/auth-options", () => ({ authOptions: {} }));
jest.mock("@/lib/prisma", () => ({
    __esModule: true,
    default: {
        program: { findUnique: jest.fn(), findMany: jest.fn().mockResolvedValue([]), updateMany: jest.fn() },
        programParticipant: { findUnique: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
        programVolunteer: { findMany: jest.fn().mockResolvedValue([]) },
        visit: { findMany: jest.fn().mockResolvedValue([]) },
        person: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
    },
}));

type Route = (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

const routes: [string, string, Route, Record<string, unknown> | undefined][] = [
    ["GET", "", GET as unknown as Route, undefined],
    ["PATCH", "", PATCH as unknown as Route, { name: "Robotics" }],
    ["POST", "/discount-code", discountCode as unknown as Route, { participantIds: [3] }],
    ["GET", "/eligible-participants", eligibleParticipants as unknown as Route, undefined],
    ["POST", "/request-payment-plan", requestPaymentPlan as unknown as Route, { participantId: 3 }],
    ["POST", "/sync-shopify", syncShopify as unknown as Route, undefined],
];

beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(getServerSession).mockResolvedValue({ user: { id: 1, isSysadmin: true, isBoardMember: true } });
});

describe.each(routes)("%s /api/programs/[id]%s malformed program ids", (method, path, route, body) => {
    it.each(["12abc", "1.5", "-3", "0", "2147483648"])("refuses program id %s with a 400 before reading the program", async (programId) => {
        const req = new Request(`http://localhost/api/programs/${programId}${path}`, {
            method,
            ...(body && { body: JSON.stringify(body) }),
        }) as unknown as NextRequest;
        const res = await route(req, { params: Promise.resolve({ id: programId }) });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual(expect.objectContaining({ error: "Invalid program ID" }));
        expect(prisma.program.findUnique).not.toHaveBeenCalled();
        expect(prisma.program.updateMany).not.toHaveBeenCalled();
        expect(prisma.programParticipant.findUnique).not.toHaveBeenCalled();
    });
});
