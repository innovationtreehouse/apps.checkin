/**
 * @jest-environment node
 */
import prisma from "@/lib/prisma";
import { DELETE, POST } from "@/app/api/programs/[id]/participants/route";

jest.mock("@/lib/prisma", () => ({ __esModule: true, default: { program: { findUnique: jest.fn() } } }));
jest.mock("@/lib/auth", () => ({
    withAuth: (_o: unknown, h: (req: unknown, auth: unknown, ctx: unknown) => unknown) =>
        (req: unknown, ctx: unknown) => h(req, { type: "session", user: { id: 1, isBoardMember: true, isSysadmin: false } }, ctx),
}));

const handlers = { POST, DELETE } as const;

const call = (method: keyof typeof handlers, programId: string, body: Record<string, unknown>) => handlers[method](
    new Request(`http://x/api/programs/${programId}/participants`, { method, body: JSON.stringify(body) }),
    { params: Promise.resolve({ id: programId }) },
);

beforeEach(() => jest.clearAllMocks());

describe.each(["POST", "DELETE"] as const)("%s /api/programs/[id]/participants malformed ids", (method) => {
    it.each(["12abc", "1.5", "-3", "2147483648"])("refuses program id %s with a 400 before reading anything", async (programId) => {
        const res = await call(method, programId, { participantId: 5 });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual(expect.objectContaining({ error: "Invalid program ID" }));
        expect(prisma.program.findUnique).not.toHaveBeenCalled();
    });

    it.each([
        ["a string", "12abc"],
        ["a float", 1.5],
        ["a negative number", -3],
        ["a value over the int4 maximum", 2147483648],
    ])("refuses participantId as %s with a 400 before reading anything", async (_label, participantId) => {
        const res = await call(method, "1", { participantId });
        expect(res.status).toBe(400);
        expect(prisma.program.findUnique).not.toHaveBeenCalled();
    });

    it("refuses a missing participantId with a 400", async () => {
        const res = await call(method, "1", {});
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual(expect.objectContaining({ error: "participantId is required" }));
    });

    it.each([
        ["not JSON", "{participantId: 5"],
        ["JSON null", "null"],
        ["a JSON array", "[5]"],
        ["a JSON number", "5"],
        ["a JSON string", '"5"'],
    ])("refuses a body that is %s with a 400 before reading anything", async (_label, raw) => {
        const res = await handlers[method](
            new Request("http://x/api/programs/1/participants", { method, body: raw }),
            { params: Promise.resolve({ id: "1" }) },
        );
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual(expect.objectContaining({ error: "Invalid JSON body" }));
        expect(prisma.program.findUnique).not.toHaveBeenCalled();
    });
});
