/**
 * @jest-environment node
 */
import { KindedError } from "@checkin/component-kit";
import { workflowRuntime } from "@checkin/workflow-mapping";
import { finishRun, inRun, newRun } from "@/lib/finishRun";
import { evaluateRun } from "@/lib/runIncidents";
import { configureRuntime } from "../configure";

// The library's real runtime, so `failed` goes through the port configureRuntime binds.
jest.mock("@checkin/workflow-mapping", () => {
    const { defineRuntime } = jest.requireActual("@checkin/component-kit");
    const workflowRuntime = defineRuntime("workflow-mapping");
    return { workflowRuntime, configureWorkflowMapping: workflowRuntime.configure };
});
jest.mock("@checkin/expense", () => ({ expenseIntake: { receive: jest.fn() } }));
jest.mock("@checkin/bulk-donation", () => ({ ingestInKind: jest.fn() }));
jest.mock("@/lib/components/host", () => ({ catalogEventsSince: jest.fn(), getOrg: jest.fn(), getPrincipal: jest.fn() }));
jest.mock("@/lib/components/orgEventAlerts", () => ({ orgEventAlerts: jest.fn() }));
jest.mock("@/lib/catalog/reader", () => ({ catalogReader: {} }));
jest.mock("@/lib/catalog/submissions", () => ({ createCatalogSubmissions: jest.fn() }));
jest.mock("@/lib/workflowMapping/inventorySink", () => ({ createLocalInventorySink: jest.fn() }));
jest.mock("@/lib/cronRuns", () => ({ recordCronRun: jest.fn() }));
jest.mock("@/lib/runIncidents", () => ({ evaluateRun: jest.fn() }));

describe("configureRuntime", () => {
    it("sends a matching give-up to the incident engine, filed under the reconcile job's mapping cause", async () => {
        jest.spyOn(console, "warn").mockImplementation(() => {});
        configureRuntime();
        const run = newRun();

        await inRun(run, async () => {
            workflowRuntime.failed("matching", new KindedError("system", "catalog unavailable"), "receipt 7");
        });
        await finishRun("reconcile-shopify", new Date("2026-11-08T09:15:00Z"), true, undefined, run);

        expect(jest.mocked(evaluateRun).mock.calls[0][0].failures).toEqual([
            { lane: "workflow-mapping matching", cause: "mapping", kind: "system", code: "system", count: 1, stopped: false },
        ]);
    });
});
