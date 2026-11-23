/**
 * @jest-environment node
 */
import prisma from "@/lib/prisma";
import { DELETE, PATCH, POST } from "@/app/api/programs/[id]/volunteers/route";

jest.mock("@/lib/prisma", () => ({ __esModule: true, default: { program: { findUnique: jest.fn() } } }));
jest.mock("@/lib/auth", () => ({
    withAuth: (_o: unknown, h: (req: unknown, auth: unknown, ctx: unknown) => unknown) =>
        (req: unknown, ctx: unknown) => h(req, { type: "session", user: { id: 1, isBoardMember: true, isSysadmin: false } }, ctx),
}));

const handlers = { POST, DELETE, PATCH } as const;

const send = (method: keyof typeof handlers, programId: string, rawBody: string) => handlers[method](
    new Request(`http://x/api/programs/${programId}/volunteers`, { method, body: rawBody }),
    { params: Promise.resolve({ id: programId }) },
);

const call = (method: keyof typeof handlers, programId: string, body: Record<string, unknown>) =>
    send(method, programId, JSON.stringify(body));

beforeEach(() => jest.clearAllMocks());

describe.each(["POST", "DELETE"] as const)("%s /api/programs/[id]/volunteers malformed ids", (method) => {
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
});

describe("PATCH /api/programs/[id]/volunteers malformed ids", () => {
    it.each(["12abc", "1.5", "-3", "2147483648"])("refuses program id %s with a 400 before reading anything", async (programId) => {
        const res = await call("PATCH", programId, { participantId: 5, isCore: true });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual(expect.objectContaining({ error: "Invalid program ID" }));
        expect(prisma.program.findUnique).not.toHaveBeenCalled();
    });

    it("refuses a string participantId with its existing message", async () => {
        const res = await call("PATCH", "1", { participantId: "12abc", isCore: true });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual(expect.objectContaining({ error: "participantId must be a number and isCore a boolean" }));
        expect(prisma.program.findUnique).not.toHaveBeenCalled();
    });

    it.each([
        ["a float", 1.5],
        ["a negative number", -3],
        ["a value over the int4 maximum", 2147483648],
    ])("refuses participantId as %s with a 400 before reading anything", async (_label, participantId) => {
        const res = await call("PATCH", "1", { participantId, isCore: true });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual(expect.objectContaining({ error: "Invalid participantId" }));
        expect(prisma.program.findUnique).not.toHaveBeenCalled();
    });

    it("refuses a missing participantId with its existing message", async () => {
        const res = await call("PATCH", "1", { isCore: true });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual(expect.objectContaining({ error: "participantId and isCore are required" }));
    });
});

describe.each(["POST", "DELETE", "PATCH"] as const)("%s /api/programs/[id]/volunteers malformed bodies", (method) => {
    it.each([
        ["not JSON", "{participantId: 5"],
        ["JSON null", "null"],
        ["a JSON array", "[5]"],
        ["a JSON number", "5"],
        ["a JSON string", '"5"'],
    ])("refuses a body that is %s with a 400 before reading anything", async (_label, raw) => {
        const res = await send(method, "1", raw);
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual(expect.objectContaining({ error: "Invalid JSON body" }));
        expect(prisma.program.findUnique).not.toHaveBeenCalled();
    });
});
