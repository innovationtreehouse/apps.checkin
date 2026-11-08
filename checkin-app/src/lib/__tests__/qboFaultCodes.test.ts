/**
 * @jest-environment node
 */
import prisma from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { recordFaultCodes } from "../qboFaultCodes";

jest.mock("@/lib/prisma", () => ({ __esModule: true, default: { qboFaultCodeSeen: { upsert: jest.fn() } } }));
jest.mock("@/lib/logger", () => ({ logger: { error: jest.fn() } }));

const upsert = jest.mocked(prisma.qboFaultCodeSeen.upsert);

beforeEach(() => jest.clearAllMocks());

describe("recordFaultCodes", () => {
    it("counts a QuickBooks lane's code under its kind, holding only code, kind, dates and lane", async () => {
        await recordFaultCodes({ lane: "expense posting", kind: "data", status: 400, faultCodes: ["6000"], requestId: "tid-1", detail: "expense 4" });

        expect(upsert).toHaveBeenCalledTimes(1);
        const arg = upsert.mock.calls[0][0];
        expect(arg.where).toEqual({ code_kind: { code: "6000", kind: "data" } });
        expect(arg.create).toEqual({ code: "6000", kind: "data", count: 1, firstSeenAt: expect.any(Date), lastSeenAt: expect.any(Date), lastLane: "expense posting" });
        expect(arg.update).toEqual({ count: { increment: 1 }, lastSeenAt: expect.any(Date), lastLane: "expense posting" });
    });

    it("counts a report carrying two codes toward each, and a repeated code once", async () => {
        await recordFaultCodes({ lane: "bulk-donation in-kind-posting", kind: "data", faultCodes: ["6000", "6190", "6000"] });

        expect(upsert.mock.calls.map(([a]) => a.where)).toEqual([
            { code_kind: { code: "6000", kind: "data" } },
            { code_kind: { code: "6190", kind: "data" } },
        ]);
    });

    it("writes nothing for a report with no codes", async () => {
        await recordFaultCodes({ lane: "expense posting", kind: "system", status: 503 });
        await recordFaultCodes({ lane: "expense posting", kind: "data", faultCodes: [] });

        expect(upsert).not.toHaveBeenCalled();
    });

    it("logs a failed write and never throws", async () => {
        upsert.mockRejectedValueOnce(new Error("db down"));

        await expect(recordFaultCodes({ lane: "expense posting", kind: "data", faultCodes: ["6000"] })).resolves.toBeUndefined();
        expect(logger.error).toHaveBeenCalledWith("[qbo fault codes] write failed:", expect.any(Error));
    });
});
