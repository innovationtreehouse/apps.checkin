/**
 * @jest-environment node
 */
import { recordCronRun } from "@/lib/cronRuns";
import { evaluateRun } from "@/lib/runIncidents";
import { finishRun, inRun, laneReached, laneStopped, newRun, reportTo, runCrashed, stepCrashed } from "../finishRun";

jest.mock("@/lib/cronRuns", () => ({ recordCronRun: jest.fn() }));
jest.mock("@/lib/runIncidents", () => ({ evaluateRun: jest.fn() }));

const STARTED = new Date("2026-11-07T09:15:00Z");
const report = () => jest.mocked(evaluateRun).mock.calls[0][0];

beforeEach(() => jest.clearAllMocks());

describe("finishRun", () => {
    it("files each library's report under the run in progress, named by library and lane", async () => {
        const run = newRun();
        await inRun(run, async () => {
            reportTo("expense")({ lane: "posting", kind: "connection", detail: "expense 4" });
            reportTo("income")({ lane: "deposit-build", kind: "system", status: 503, detail: "payout reconciliation 9" });
            laneReached("expense posting", "income deposit-build");
        });

        await finishRun("qbo-posting", STARTED, true, undefined, run);

        expect(report().failures).toEqual([
            { lane: "expense posting", cause: "quickbooks", kind: "connection", code: "connection", count: 1, stopped: false },
            { lane: "income deposit-build", cause: "quickbooks", kind: "system", code: "HTTP 503", count: 1, stopped: false },
        ]);
        expect(report().lanes).toEqual(["qbo-posting", "expense posting", "income deposit-build"]);
    });

    it("counts each item once per run however many times its lane reports it", async () => {
        const run = newRun();
        const port = reportTo("expense");
        await inRun(run, async () => {
            port({ lane: "intake-replay", kind: "settings", detail: "receipt 1" });
            port({ lane: "intake-replay", kind: "settings", detail: "receipt 1" });
            port({ lane: "intake-replay", kind: "settings", detail: "receipt 2" });
        });

        await finishRun("reconcile-shopify", STARTED, true, undefined, run);

        expect(report().failures).toEqual([{ lane: "expense intake-replay", cause: "intake", kind: "settings", code: "settings", count: 2, stopped: false }]);
        expect(recordCronRun).toHaveBeenCalledWith("reconcile-shopify", STARTED, true, undefined, { settings: 2 });
    });

    it("reaches the receipt lanes, so a held receipt's connection or settings failure opens an incident", async () => {
        const run = newRun();
        await inRun(run, async () => {
            reportTo("receipt")({ lane: "push", kind: "connection", detail: "receipt 3" });
            reportTo("receipt")({ lane: "mail-listing", kind: "settings" });
            reportTo("receipt")({ lane: "ocr", kind: "system", detail: "receipt 4" });
            laneReached("receipt push", "receipt mail-listing", "receipt ocr");
        });

        await finishRun("reconcile-shopify", STARTED, true, undefined, run);

        expect(report().failures).toEqual([
            expect.objectContaining({ lane: "receipt push", cause: "mapping", kind: "connection", count: 1 }),
            expect.objectContaining({ lane: "receipt mail-listing", cause: "gmail", kind: "settings", count: 1 }),
            expect.objectContaining({ lane: "receipt ocr", cause: "ocr", kind: "system", count: 1 }),
        ]);
        expect(report().lanes).toEqual(expect.arrayContaining(["receipt push", "receipt mail-listing", "receipt ocr"]));
    });

    it("keeps a QuickBooks refusal's fault codes as its code", async () => {
        const run = newRun();
        await inRun(run, async () => reportTo("bulk-donation")({ lane: "in-kind-posting", kind: "bug", status: 400, faultCodes: ["6000", "610"] }));

        await finishRun("qbo-posting", STARTED, true, undefined, run);

        expect(report().failures).toEqual([expect.objectContaining({ lane: "bulk-donation in-kind-posting", kind: "bug", code: "6000+610" })]);
    });

    it("marks a stopped lane's failures stopped", async () => {
        const run = newRun();
        await inRun(run, async () => {
            reportTo("expense")({ lane: "posting", kind: "system", detail: "expense 1" });
            laneStopped("expense posting");
        });

        await finishRun("qbo-posting", STARTED, true, undefined, run);

        expect(report().failures).toEqual([expect.objectContaining({ lane: "expense posting", stopped: true })]);
    });

    it("reports a crashed step on the job's own lane, a bug unless its error has a kind", async () => {
        const run = newRun();
        await inRun(run, async () => stepCrashed("reconcile-shopify", "income", new Error("boom")));

        await finishRun("reconcile-shopify", STARTED, true, undefined, run);

        expect(report().failures).toEqual([{ lane: "reconcile-shopify", cause: "reconcile-shopify", kind: "bug", code: "income crashed", count: 1, stopped: false }]);
        expect(report().lanes).toContain("reconcile-shopify");
    });

    it("covers only the lanes the run reached", async () => {
        const run = newRun();
        await inRun(run, async () => laneReached("receipt push"));

        await finishRun("reconcile-shopify", STARTED, true, undefined, run);

        expect(report().lanes).toEqual(["reconcile-shopify", "receipt push"]);
    });

    it("files a crashed step under the library lanes it runs, with their cause, and leaves them uncovered", async () => {
        const run = newRun();
        await inRun(run, async () => stepCrashed("qbo-posting", "expense", new Error("boom"), ["expense posting"]));

        await finishRun("qbo-posting", STARTED, true, undefined, run);

        expect(report()).toEqual({
            lanes: ["qbo-posting"],
            failures: [{ lane: "expense posting", cause: "quickbooks", kind: "bug", code: "expense crashed", count: 1, stopped: false }],
        });
    });

    it("a run that crashed covers no library lane", async () => {
        const run = newRun();
        await inRun(run, async () => laneReached("receipt push"));
        runCrashed(run, "reconcile-shopify", new Error("boom"));

        await finishRun("reconcile-shopify", STARTED, false, undefined, run);

        expect(report().lanes).toEqual(["reconcile-shopify"]);
    });

    it("drops a report made outside any run", async () => {
        reportTo("receipt")({ lane: "push", kind: "connection", detail: "receipt 3" });
        const run = newRun();

        await finishRun("nightly", STARTED, true, undefined, run);

        expect(report()).toEqual({ lanes: ["nightly"], failures: [] });
        expect(recordCronRun).toHaveBeenCalledWith("nightly", STARTED, true, undefined, {});
    });

    it("keeps overlapping runs apart", async () => {
        const a = newRun();
        const b = newRun();
        await Promise.all([
            inRun(a, async () => { await Promise.resolve(); reportTo("expense")({ lane: "posting", kind: "system", detail: "expense 1" }); }),
            inRun(b, async () => reportTo("receipt")({ lane: "push", kind: "system", detail: "receipt 1" })),
        ]);

        expect(a.reports.map((r) => r.lane)).toEqual(["expense posting"]);
        expect(b.reports.map((r) => r.lane)).toEqual(["receipt push"]);
    });
});
