/**
 * @jest-environment node
 */
import type { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { POST } from "../route";

jest.mock("@/lib/auth", () => ({
    withAuth: (_o: unknown, h: (req: unknown, auth: unknown, ctx: unknown) => unknown) =>
        (req: unknown, ctx: unknown) => h(req, { type: "session", user: { id: 2, isSysadmin: false, isBoardMember: true } }, ctx),
}));
jest.mock("@/lib/prisma", () => ({
    __esModule: true,
    default: { programParticipant: { findUnique: jest.fn(), updateMany: jest.fn() } },
}));

const send = (rawBody: string) => (POST as unknown as (req: NextRequest, ctx: unknown) => Promise<Response>)(
    new Request("http://localhost/api/programs/10/request-payment-plan", { method: "POST", body: rawBody }) as unknown as NextRequest,
    { params: Promise.resolve({ id: "10" }) },
);

beforeEach(() => jest.clearAllMocks());

describe("POST /api/programs/[id]/request-payment-plan malformed bodies", () => {
    it.each([
        ["not JSON", "{participantId: 3"],
        ["JSON null", "null"],
        ["a JSON array", "[3]"],
        ["a JSON number", "3"],
        ["a JSON string", '"3"'],
    ])("refuses a body that is %s with a 400 before reading anything", async (_label, raw) => {
        const res = await send(raw);
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual(expect.objectContaining({ error: "Invalid JSON body" }));
        expect(prisma.programParticipant.findUnique).not.toHaveBeenCalled();
    });

    it.each([
        ["a string", "12abc"],
        ["a float", 1.5],
        ["a negative number", -3],
        ["a value over the int4 maximum", 2147483648],
    ])("refuses participantId as %s with a 400 before reading anything", async (_label, participantId) => {
        const res = await send(JSON.stringify({ participantId, kind: "SCHOLARSHIP" }));
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual(expect.objectContaining({ error: "Invalid participantId" }));
        expect(prisma.programParticipant.findUnique).not.toHaveBeenCalled();
    });

    it("refuses a missing participantId with its existing message", async () => {
        const res = await send(JSON.stringify({ kind: "SCHOLARSHIP" }));
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual(expect.objectContaining({ error: "participantId is required" }));
    });

    it("refuses an unknown kind with its existing message", async () => {
        const res = await send(JSON.stringify({ participantId: 3, kind: "GRANT" }));
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual(expect.objectContaining({ error: "kind must be SCHOLARSHIP, PAYMENT_PLAN or UNSURE" }));
        expect(prisma.programParticipant.findUnique).not.toHaveBeenCalled();
    });
});
