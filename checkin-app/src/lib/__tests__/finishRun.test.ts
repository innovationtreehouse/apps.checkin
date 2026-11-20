/**
 * @jest-environment node
 */
import { recordCronRun } from "@/lib/cronRuns";
import { recordFaultCodes } from "@/lib/qboFaultCodes";
import { finishRun, inRun, newRun, reportTo, runCrashed, stepCrashed } from "../finishRun";

jest.mock("@/lib/cronRuns", () => ({ recordCronRun: jest.fn() }));
jest.mock("@/lib/qboFaultCodes", () => ({ recordFaultCodes: jest.fn() }));

const STARTED = new Date("2026-11-07T09:15:00Z");
const recorded = () => jest.mocked(recordCronRun).mock.calls[0][4];

beforeEach(() => jest.clearAllMocks());

describe("finishRun", () => {
    it("records the run with each library report of the run in progress, counted by kind", async () => {
        const run = newRun();
        await inRun(run, async () => {
            reportTo("expense")({ lane: "posting", kind: "connection", detail: "expense 4" });
            reportTo("income")({ lane: "deposit-build", kind: "system", status: 503, detail: "payout reconciliation 9" });
        });

        await finishRun("qbo-posting", STARTED, true, undefined, run);

        expect(recordCronRun).toHaveBeenCalledWith("qbo-posting", STARTED, true, undefined, { connection: 1, system: 1 });
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

        expect(recordCronRun).toHaveBeenCalledWith("reconcile-shopify", STARTED, true, undefined, { settings: 2 });
    });

    it("counts an item again under a different code", async () => {
        const run = newRun();
        const port = reportTo("bulk-donation");
        await inRun(run, async () => {
            port({ lane: "in-kind-posting", kind: "bug", status: 400, faultCodes: ["6000", "610"], detail: "gift 1" });
            port({ lane: "in-kind-posting", kind: "bug", status: 400, faultCodes: ["6000"], detail: "gift 1" });
        });

        await finishRun("qbo-posting", STARTED, true, undefined, run);

        expect(recorded()).toEqual({ bug: 2 });
    });

    it("counts a crashed step once per library lane it runs, a bug unless its error has a kind", async () => {
        const run = newRun();
        await inRun(run, async () => {
            stepCrashed("reconcile-shopify", "income", new Error("boom"));
            stepCrashed("reconcile-shopify", "expense", new Error("boom"), ["expense intake", "expense intake-replay"]);
        });

        await finishRun("reconcile-shopify", STARTED, true, undefined, run);

        expect(recorded()).toEqual({ bug: 3 });
    });

    it("counts a run that crashed as a failure of the job's own lane", async () => {
        const run = newRun();
        runCrashed(run, "reconcile-shopify", new Error("boom"));

        await finishRun("reconcile-shopify", STARTED, false, "boom", run);

        expect(recordCronRun).toHaveBeenCalledWith("reconcile-shopify", STARTED, false, "boom", { bug: 1 });
    });

    it("drops a report made outside any run", async () => {
        reportTo("expense")({ lane: "intake", kind: "connection", detail: "receipt 3" });
        const run = newRun();

        await finishRun("nightly", STARTED, true, undefined, run);

        expect(recordCronRun).toHaveBeenCalledWith("nightly", STARTED, true, undefined, {});
    });

    it("keeps overlapping runs apart", async () => {
        const a = newRun();
        const b = newRun();
        await Promise.all([
            inRun(a, async () => { await Promise.resolve(); reportTo("expense")({ lane: "posting", kind: "system", detail: "expense 1" }); }),
            inRun(b, async () => reportTo("expense")({ lane: "intake", kind: "system", detail: "receipt 1" })),
        ]);

        expect(a.reports.map((r) => r.lane)).toEqual(["expense posting"]);
        expect(b.reports.map((r) => r.lane)).toEqual(["expense intake"]);
    });
});

describe("reportTo and the QuickBooks fault-code table", () => {
    it("records each QuickBooks lane's report, in a run or not", async () => {
        const refusal = { kind: "data", status: 400, faultCodes: ["6000"] } as const;
        reportTo("expense")({ lane: "posting", ...refusal });
        await inRun(newRun(), async () => reportTo("bulk-donation")({ lane: "in-kind-posting", ...refusal }));
        reportTo("income")({ lane: "deposit-build", ...refusal });

        expect(jest.mocked(recordFaultCodes).mock.calls.map(([r]) => r.lane)).toEqual(["expense posting", "bulk-donation in-kind-posting", "income deposit-build"]);
    });

    it("records nothing for a lane outside QuickBooks", () => {
        reportTo("expense")({ lane: "intake", kind: "data", faultCodes: ["6000"] });

        expect(recordFaultCodes).not.toHaveBeenCalled();
    });
});
