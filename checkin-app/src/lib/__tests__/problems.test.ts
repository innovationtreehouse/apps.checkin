/**
 * @jest-environment node
 */
import { getCronJobStatuses } from "@/lib/cronRuns";
import type { TemplateCtx } from "@/lib/email-templates/registry";
import { sendTemplated } from "@/lib/email-templates/send";
import prisma from "@/lib/prisma";
import { getProblems, sendProblemsDigest } from "../problems";

jest.mock("@/lib/cronRuns", () => ({ getCronJobStatuses: jest.fn() }));
jest.mock("@/lib/email-templates/send", () => ({ sendTemplated: jest.fn() }));
jest.mock("@checkin/receipt", () => ({ stuckItems: jest.fn(), problemNotices: jest.fn() }));
jest.mock("@checkin/expense", () => ({ stuckItems: jest.fn() }));
jest.mock("@checkin/bulk-donation", () => ({ stuckItems: jest.fn() }));
jest.mock("@checkin/workflow-mapping", () => ({ stuckItems: jest.fn() }));
jest.mock("@checkin/local-inventory", () => ({ stuckItems: jest.fn() }));

const receipt = jest.requireMock<{ stuckItems: jest.Mock; problemNotices: jest.Mock }>("@checkin/receipt");
const expense = jest.requireMock<{ stuckItems: jest.Mock }>("@checkin/expense");
const gifts = jest.requireMock<{ stuckItems: jest.Mock }>("@checkin/bulk-donation");
const mapping = jest.requireMock<{ stuckItems: jest.Mock }>("@checkin/workflow-mapping");
const inventory = jest.requireMock<{ stuckItems: jest.Mock }>("@checkin/local-inventory");

const NOW = new Date("2026-11-08T08:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000);
const findSettings = jest.fn();
const digestCtx = () => jest.mocked(sendTemplated).mock.calls[0][2] as TemplateCtx<"ops.problemsDigest">;
const ENV = ["RECEIPT_DATABASE_URL", "EXPENSE_DATABASE_URL", "BULK_DONATION_DATABASE_URL", "WORKFLOW_MAPPING_DATABASE_URL", "LOCAL_INVENTORY_DATABASE_URL"];

beforeEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    for (const name of ENV) process.env[name] = "postgres://test";
    for (const lib of [receipt, expense, gifts, mapping, inventory]) lib.stuckItems.mockResolvedValue([]);
    receipt.problemNotices.mockResolvedValue([]);
    prisma.boardSettings.findUnique = findSettings;
    findSettings.mockResolvedValue({ alertEmailAddress: "alerts@example.org", boardEmailAddress: "board@example.org" });
    jest.mocked(getCronJobStatuses).mockResolvedValue([{ job: "nightly", lastSuccessAt: hoursAgo(1), stale: false }]);
    jest.mocked(sendTemplated).mockResolvedValue(true);
});

afterAll(() => {
    for (const name of ENV) delete process.env[name];
});

describe("getProblems", () => {
    it("lists every library's stuck items, oldest first, each named by its library", async () => {
        expense.stuckItems.mockResolvedValue([{ id: "e1", step: "QuickBooks posting", href: null, failedAt: hoursAgo(5) }]);
        mapping.stuckItems.mockResolvedValue([{ id: "r1", step: "apply", href: null, failedAt: hoursAgo(50) }]);

        const { items, unread, notices } = await getProblems();

        expect(items.map((i) => [i.library, i.id])).toEqual([["workflow mapping", "r1"], ["expense", "e1"]]);
        expect(items[1]).toMatchObject({ step: "QuickBooks posting" });
        expect(unread).toEqual([]);
        expect(notices).toEqual([]);
    });

    it("carries a library's own lines, such as repeated reading failures", async () => {
        receipt.problemNotices.mockResolvedValue(["Receipt reading failed 3 times in the last day"]);
        expect((await getProblems()).notices).toEqual(["Receipt reading failed 3 times in the last day"]);
    });

    it("names a library whose lines cannot be read", async () => {
        jest.spyOn(console, "error").mockImplementation(() => undefined);
        receipt.problemNotices.mockRejectedValue(new Error("db down"));
        expect(await getProblems()).toMatchObject({ unread: ["receipt"], notices: [] });
    });

    it("names a library whose read fails and still lists the others", async () => {
        const logged = jest.spyOn(console, "error").mockImplementation(() => undefined);
        gifts.stuckItems.mockRejectedValue(new Error("db down"));
        receipt.stuckItems.mockResolvedValue([{ id: "x", step: "flow", href: null, failedAt: hoursAgo(1) }]);

        const { items, unread } = await getProblems();

        expect(unread).toEqual(["gifts"]);
        expect(items).toHaveLength(1);
        expect(logged).toHaveBeenCalledWith(expect.stringContaining("gifts"), expect.any(Error));
    });

    it("skips a library with no database configured", async () => {
        delete process.env.LOCAL_INVENTORY_DATABASE_URL;
        await getProblems();
        expect(inventory.stuckItems).not.toHaveBeenCalled();
    });
});

describe("sendProblemsDigest", () => {
    it("sends nothing while nothing has been stuck more than a day", async () => {
        receipt.stuckItems.mockResolvedValue([{ id: "x", step: "flow", href: null, failedAt: hoursAgo(23) }]);
        await sendProblemsDigest(NOW);
        expect(sendTemplated).not.toHaveBeenCalled();
    });

    it("emails the alert address the items stuck more than a day", async () => {
        receipt.stuckItems.mockResolvedValue([
            { id: "old", step: "flow", href: null, failedAt: hoursAgo(30) },
            { id: "new", step: "flow", href: null, failedAt: hoursAgo(2) },
        ]);

        await sendProblemsDigest(NOW);

        expect(sendTemplated).toHaveBeenCalledTimes(1);
        const [key, to] = jest.mocked(sendTemplated).mock.calls[0];
        const ctx = digestCtx();
        expect(key).toBe("ops.problemsDigest");
        expect(to).toBe("alerts@example.org");
        expect(ctx.count).toBe("1");
        expect(ctx.items).toContain("old");
        expect(ctx.items).not.toContain("new");
    });

    it("emails the alert address a library's line on its own, without copying the Board", async () => {
        receipt.problemNotices.mockResolvedValue(["Receipt reading failed 3 times in the last day"]);

        await sendProblemsDigest(NOW);

        expect(jest.mocked(sendTemplated).mock.calls.map((c) => c[1])).toEqual(["alerts@example.org"]);
        expect(digestCtx().items).toBe("Receipt reading failed 3 times in the last day");
    });

    it("copies the Board once anything has been stuck more than two weeks", async () => {
        expense.stuckItems.mockResolvedValue([{ id: "e1", step: "intake", href: null, failedAt: hoursAgo(15 * 24) }]);

        await sendProblemsDigest(NOW);

        expect(jest.mocked(sendTemplated).mock.calls.map((c) => c[1])).toEqual(["alerts@example.org", "board@example.org"]);
    });

    it("counts a job that has not run on time", async () => {
        jest.mocked(getCronJobStatuses).mockResolvedValue([{ job: "qbo-posting", lastSuccessAt: hoursAgo(72), stale: true }]);

        await sendProblemsDigest(NOW);

        const ctx = digestCtx();
        expect(ctx.items).toContain("qbo-posting");
    });

    it("an unset address sends nothing, with no fallback", async () => {
        findSettings.mockResolvedValue({ alertEmailAddress: " ", boardEmailAddress: null });
        expense.stuckItems.mockResolvedValue([{ id: "e1", step: "intake", href: null, failedAt: hoursAgo(20 * 24) }]);

        await sendProblemsDigest(NOW);

        expect(sendTemplated).not.toHaveBeenCalled();
    });

    it("never throws", async () => {
        const logged = jest.spyOn(console, "error").mockImplementation(() => undefined);
        findSettings.mockRejectedValue(new Error("db down"));
        await expect(sendProblemsDigest(NOW)).resolves.toBeUndefined();
        expect(logged).toHaveBeenCalledWith("[problems] daily email failed:", expect.any(Error));
    });
});
