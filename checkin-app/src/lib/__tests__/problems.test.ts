/**
 * @jest-environment node
 */
import { ServiceError } from "@checkin/component-kit";
import { getCronJobStatuses } from "@/lib/cronRuns";
import type { TemplateCtx } from "@/lib/email-templates/registry";
import { sendTemplated } from "@/lib/email-templates/send";
import prisma from "@/lib/prisma";
import { getProblems, LIBRARY_DB_VARS, retryProblem, sendProblemsDigest } from "../problems";

jest.mock("@/lib/cronRuns", () => ({ getCronJobStatuses: jest.fn() }));
jest.mock("@/lib/email-templates/send", () => ({ sendTemplated: jest.fn() }));
jest.mock("@checkin/receipt", () => ({ stuckItems: jest.fn(), problemNotices: jest.fn(), retryStuckItem: jest.fn() }));
jest.mock("@checkin/expense", () => ({ stuckItems: jest.fn(), retryStuckItem: jest.fn() }));
jest.mock("@checkin/bulk-donation", () => ({ stuckItems: jest.fn(), retryStuckItem: jest.fn(), getOrgId: jest.fn(), manualInKindService: { loadInventory: jest.fn() } }));
jest.mock("@checkin/workflow-mapping", () => ({ stuckItems: jest.fn(), problemNotices: jest.fn(), retryStuckItem: jest.fn() }));
jest.mock("@checkin/local-inventory", () => ({ stuckItems: jest.fn(), retryStuckItem: jest.fn() }));
jest.mock("@/lib/finance/postingRuns", () => ({ currentPostingWarnings: jest.fn() }));
jest.mock("@/lib/membership/positionCheck", () => ({ checkEmailStuckItems: jest.fn(), retryCheckEmail: jest.fn() }));

const receipt = jest.requireMock<{ stuckItems: jest.Mock; problemNotices: jest.Mock; retryStuckItem: jest.Mock }>("@checkin/receipt");
const expense = jest.requireMock<{ stuckItems: jest.Mock; retryStuckItem: jest.Mock }>("@checkin/expense");
const gifts = jest.requireMock<{ stuckItems: jest.Mock; retryStuckItem: jest.Mock; getOrgId: jest.Mock; manualInKindService: { loadInventory: jest.Mock } }>("@checkin/bulk-donation");
const mapping = jest.requireMock<{ stuckItems: jest.Mock; problemNotices: jest.Mock; retryStuckItem: jest.Mock }>("@checkin/workflow-mapping");
const inventory = jest.requireMock<{ stuckItems: jest.Mock; retryStuckItem: jest.Mock }>("@checkin/local-inventory");
const { currentPostingWarnings } = jest.requireMock<{ currentPostingWarnings: jest.Mock }>("@/lib/finance/postingRuns");
const positionCheck = jest.requireMock<{ checkEmailStuckItems: jest.Mock; retryCheckEmail: jest.Mock }>("@/lib/membership/positionCheck");

const NOW = new Date("2026-11-08T08:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000);
const findSettings = jest.fn();
const countEmailFailures = jest.fn();
const digestCtx = () => jest.mocked(sendTemplated).mock.calls[0][2] as TemplateCtx<"ops.problemsDigest">;

beforeEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    for (const name of LIBRARY_DB_VARS) process.env[name] = "postgres://test";
    for (const lib of [receipt, expense, gifts, mapping, inventory]) lib.stuckItems.mockResolvedValue([]);
    receipt.problemNotices.mockResolvedValue([]);
    mapping.problemNotices.mockResolvedValue([]);
    prisma.boardSettings.findUnique = findSettings;
    prisma.integrationErrorLog.count = countEmailFailures;
    prisma.orgMembershipProcess.findMany = jest.fn().mockResolvedValue([]);
    countEmailFailures.mockResolvedValue(0);
    findSettings.mockResolvedValue({ alertEmailAddress: "alerts@example.org", boardEmailAddress: "board@example.org" });
    jest.mocked(getCronJobStatuses).mockResolvedValue([{ job: "nightly", lastSuccessAt: hoursAgo(1), stale: false }]);
    jest.mocked(sendTemplated).mockResolvedValue(true);
    currentPostingWarnings.mockResolvedValue([]);
    positionCheck.checkEmailStuckItems.mockResolvedValue([]);
});

afterAll(() => {
    for (const name of LIBRARY_DB_VARS) delete process.env[name];
});

describe("retryProblem", () => {
    const BY = { userId: 5, username: "Pat" };

    it("retries a background-check email with no library database configured", async () => {
        for (const name of LIBRARY_DB_VARS) delete process.env[name];
        await retryProblem({ library: "background check", step: "check email", id: "7" }, BY);

        expect(positionCheck.retryCheckEmail).toHaveBeenCalledWith({ id: "7", step: "check email" }, BY);
    });

    it("hands the expense library the person who pressed Retry", async () => {
        await retryProblem({ library: "expense", step: "QuickBooks posting", id: "e1" }, BY);

        expect(expense.retryStuckItem).toHaveBeenCalledWith({ id: "e1", step: "QuickBooks posting" }, BY);
    });

    it("runs the step through the library the item is listed under", async () => {
        await retryProblem({ library: "gifts", step: "QuickBooks posting", id: "receipt 4" }, BY);

        expect(gifts.retryStuckItem).toHaveBeenCalledWith({ id: "receipt 4", step: "QuickBooks posting" });
        expect(expense.retryStuckItem).not.toHaveBeenCalled();
    });

    describe("a manual gift's inventory load", () => {
        const DELTA = { library: "local inventory", step: "inventory delta", id: "donation:12" };

        beforeEach(() => {
            gifts.getOrgId.mockResolvedValue("org-1");
            inventory.retryStuckItem.mockResolvedValue(undefined);
            gifts.manualInKindService.loadInventory.mockResolvedValue(undefined);
        });

        it("marks the gift loaded once the retried load applies", async () => {
            await retryProblem(DELTA, BY);

            expect(inventory.retryStuckItem).toHaveBeenCalledWith({ id: "donation:12", step: "inventory delta" });
            expect(gifts.manualInKindService.loadInventory).toHaveBeenCalledWith("org-1", 12);
        });

        it("leaves the gift alone when the retried load fails again", async () => {
            inventory.retryStuckItem.mockRejectedValue(new ServiceError(409, "failed again"));

            await expect(retryProblem(DELTA, BY)).rejects.toMatchObject({ status: 409 });
            expect(gifts.manualInKindService.loadInventory).not.toHaveBeenCalled();
        });

        it("still succeeds when the gift cannot be marked loaded", async () => {
            const logged = jest.spyOn(console, "error").mockImplementation(() => {});
            gifts.manualInKindService.loadInventory.mockRejectedValue(new Error("gifts db down"));

            await expect(retryProblem(DELTA, BY)).resolves.toBeUndefined();
            expect(logged).toHaveBeenCalledWith(expect.stringContaining("donation:12"), expect.any(Error));
        });

        it.each([
            ["a receipt's delta", { ...DELTA, id: "rcpt-1" }],
            ["a catalog event", { ...DELTA, step: "catalog event", id: "8" }],
            ["a provisional item", { ...DELTA, step: "provisional item", id: "2000000000015" }],
        ])("does not touch gifts for %s", async (_what, item) => {
            await retryProblem(item, BY);

            expect(inventory.retryStuckItem).toHaveBeenCalledWith({ id: item.id, step: item.step });
            expect(gifts.manualInKindService.loadInventory).not.toHaveBeenCalled();
        });
    });

    it("hands the receipt library who pressed Retry", async () => {
        await retryProblem({ library: "receipt", step: "mail message", id: "7" }, BY);

        expect(receipt.retryStuckItem).toHaveBeenCalledWith({ id: "7", step: "mail message" }, BY);
    });

    it("passes the library's refusal through", async () => {
        receipt.retryStuckItem.mockRejectedValue(new ServiceError(409, "failed again"));

        await expect(retryProblem({ library: "receipt", step: "flow", id: "r1" }, BY)).rejects.toMatchObject({ status: 409 });
    });

    it.each([
        ["a library not on the list", "inventory"],
        ["a library with no database", "expense"],
    ])("answers 404 for %s", async (_what, library) => {
        delete process.env.EXPENSE_DATABASE_URL;

        await expect(retryProblem({ library, step: "intake", id: "e1" }, BY)).rejects.toMatchObject({ status: 404 });
        expect(expense.retryStuckItem).not.toHaveBeenCalled();
    });
});

describe("getProblems", () => {
    it("lists every library's stuck items, oldest first, each named by its library", async () => {
        expense.stuckItems.mockResolvedValue([{ id: "e1", step: "QuickBooks posting", href: null, failedAt: hoursAgo(5) }]);
        mapping.stuckItems.mockResolvedValue([{ id: "r1", step: "apply", href: null, failedAt: hoursAgo(50) }]);
        positionCheck.checkEmailStuckItems.mockResolvedValue([{ id: "9", step: "check email", href: "/membership-ops/roles", failedAt: hoursAgo(2) }]);

        const { items, unread, notices } = await getProblems();

        expect(items.map((i) => [i.library, i.id])).toEqual([["workflow mapping", "r1"], ["expense", "e1"], ["background check", "9"]]);
        expect(items[1]).toMatchObject({ step: "QuickBooks posting" });
        expect(unread).toEqual([]);
        expect(notices).toEqual([]);
    });

    it("carries a library's own lines, such as repeated reading failures", async () => {
        receipt.problemNotices.mockResolvedValue(["Receipt reading failed 3 times in the last day"]);
        expect((await getProblems()).notices).toEqual([{ text: "Receipt reading failed 3 times in the last day", href: null }]);
    });

    it("carries the catalog-error count with its link to the mapping queue", async () => {
        const line = { text: "Receipts in Matching pending because the catalog was unavailable: 2", href: "/inventory/receiving?queue=mapping" };
        mapping.problemNotices.mockResolvedValue([line]);
        expect((await getProblems()).notices).toEqual([line]);
    });

    it("has no email line while no email failed to send in the last day", async () => {
        expect((await getProblems(NOW)).notices).toEqual([]);
    });

    it("counts email sends that failed in the last day, linking to Link Status", async () => {
        countEmailFailures.mockResolvedValue(1);

        const { notices } = await getProblems(NOW);

        expect(countEmailFailures).toHaveBeenCalledWith({ where: { source: "email", timestamp: { gt: hoursAgo(24), lte: NOW } } });
        expect(notices).toEqual([{ text: "Emails failed to send: 1 in the last day", href: "/system-status/links" }]);
        expect(JSON.stringify(notices)).not.toMatch(/@|subject/i);
    });

    it("names email as unread when its failures cannot be counted", async () => {
        jest.spyOn(console, "error").mockImplementation(() => undefined);
        countEmailFailures.mockRejectedValue(new Error("db down"));
        expect(await getProblems(NOW)).toMatchObject({ unread: ["email"], notices: [] });
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
    it("emails the calling run's own failures, which no run record holds yet", async () => {
        await sendProblemsDigest(NOW, ["Nightly close could not check out visit 7, person 3"]);

        expect(jest.mocked(sendTemplated).mock.calls.map((c) => c[1])).toEqual(["alerts@example.org"]);
        expect(digestCtx().items).toBe("Nightly close could not check out visit 7, person 3");
    });

    it("emails the QuickBooks posting warnings in force, whichever run went first", async () => {
        currentPostingWarnings.mockResolvedValue([{ lane: "income", cause: "throttled", text: "QuickBooks throttled the income run 3 runs in a row." }]);
        await sendProblemsDigest(NOW);
        expect(digestCtx().items).toBe("QuickBooks posting: QuickBooks throttled the income run 3 runs in a row.");
    });

    it("still sends when the QuickBooks posting warnings can't be read", async () => {
        currentPostingWarnings.mockRejectedValue(new Error("db down"));
        jest.spyOn(console, "error").mockImplementation(() => {});
        await sendProblemsDigest(NOW, ["Nightly close could not check out visit 7, person 3"]);
        expect(digestCtx().items).toBe("Nightly close could not check out visit 7, person 3");
    });

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
        expect(jest.mocked(sendTemplated).mock.calls).toHaveLength(1);
    });

    it("emails the alert address a failed email send on its own, as a count with no recipient or subject", async () => {
        countEmailFailures.mockResolvedValue(1);

        await sendProblemsDigest(NOW);

        expect(jest.mocked(sendTemplated).mock.calls.map((c) => c[1])).toEqual(["alerts@example.org"]);
        expect(digestCtx().items).toBe("Emails failed to send: 1 in the last day");
    });

    it("emails the alert address the sources that could not be read, without the error text", async () => {
        jest.spyOn(console, "error").mockImplementation(() => undefined);
        countEmailFailures.mockRejectedValue(new Error("db down"));
        gifts.stuckItems.mockRejectedValue(new Error("db down"));

        await sendProblemsDigest(NOW);

        expect(jest.mocked(sendTemplated).mock.calls.map((c) => c[1])).toEqual(["alerts@example.org"]);
        expect(digestCtx().items).toBe("Could not read the stuck items in gifts.\nFailed email sends could not be counted.");
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

    it("sends a job whose latest run reported failures, without its error text", async () => {
        jest.mocked(getCronJobStatuses).mockResolvedValue([
            { job: "reconcile-shopify", lastSuccessAt: hoursAgo(2), stale: false, lastError: "1 item(s) failed", lastErrorAt: hoursAgo(2) },
        ]);

        await sendProblemsDigest(NOW);

        expect(jest.mocked(sendTemplated).mock.calls.map((c) => c[1])).toEqual(["alerts@example.org"]);
        expect(digestCtx().items).toMatch(/^Scheduled job reconcile-shopify: last run reported failures, /);
        expect(digestCtx().items).not.toContain("item(s) failed");
    });

    it("sends a job that has never completed a run", async () => {
        jest.mocked(getCronJobStatuses).mockResolvedValue([
            { job: "new-job", lastSuccessAt: null, stale: false, lastError: "boom", lastErrorAt: hoursAgo(1) },
        ]);

        await sendProblemsDigest(NOW);

        expect(digestCtx().items).toMatch(/^Scheduled job new-job: last run reported failures, /);
    });

    it("sends nothing for a job once a later run is clean", async () => {
        jest.mocked(getCronJobStatuses).mockResolvedValue([{ job: "reconcile-shopify", lastSuccessAt: hoursAgo(1), stale: false }]);
        await sendProblemsDigest(NOW);
        expect(sendTemplated).not.toHaveBeenCalled();
    });

    it("lists a job that is late and failing once, as late", async () => {
        jest.mocked(getCronJobStatuses).mockResolvedValue([
            { job: "nightly", lastSuccessAt: hoursAgo(72), stale: true, lastError: "boom", lastErrorAt: hoursAgo(1) },
        ]);

        await sendProblemsDigest(NOW);

        expect(digestCtx().count).toBe("1");
        expect(digestCtx().items).toMatch(/^Scheduled job nightly: last ran /);
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
