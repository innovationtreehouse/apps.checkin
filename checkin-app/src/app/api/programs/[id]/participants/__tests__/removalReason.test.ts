/**
 * @jest-environment node
 */
import prisma from "@/lib/prisma";
import { DELETE } from "@/app/api/programs/[id]/participants/route";

jest.mock("@/lib/prisma", () => ({ __esModule: true, default: { program: { findUnique: jest.fn() } } }));
jest.mock("@/lib/auth", () => ({
    withAuth: (_o: unknown, h: (req: unknown, auth: unknown, ctx: unknown) => unknown) =>
        (req: unknown, ctx: unknown) => h(req, { type: "session", user: { id: 1, isBoardMember: true, isSysadmin: false } }, ctx),
}));

const remove = (reason: string) => DELETE(
    new Request("http://x/api/programs/1/participants", { method: "DELETE", body: JSON.stringify({ participantId: 5, reason }) }),
    { params: Promise.resolve({ id: "1" }) },
);

describe("DELETE /api/programs/[id]/participants removal reason", () => {
    it("refuses a reason over 2000 characters before reading anything", async () => {
        const res = await remove("x".repeat(2001));
        expect(res.status).toBe(400);
        expect(prisma.program.findUnique).not.toHaveBeenCalled();
    });
});
