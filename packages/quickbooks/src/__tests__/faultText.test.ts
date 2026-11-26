import { inspect } from "node:util";
import { defineRuntime, type FailureReport } from "@checkin/component-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QboRequestError } from "../client";
import { FAULT_TEXT_REDACTED, FaultText, faultTextOf } from "../faultText";
import { faultTextColumn, postFailure, postFailureError } from "../write";

const WORDS = "Duplicate Name Exists Error: The name supplied already exists. : Jane Donor";
const refusal = () => new QboRequestError("QBO create Bill failed 400 (intuit_tid=t1)", 400, "t1", ["6240"], new FaultText(WORDS));

type Config = { onFailure?: (r: FailureReport) => void };
const runtime = defineRuntime<Config, { id: number }>("fault-text-test");

/** Everything console printed, as Node would write it. */
function printed(spies: ReturnType<typeof vi.spyOn>[]): string {
  return spies.flatMap((s) => s.mock.calls).map((args) => args.map((a: unknown) => (typeof a === "string" ? a : inspect(a, { depth: 8 }))).join(" ")).join("\n");
}

afterEach(() => {
  vi.restoreAllMocks();
  runtime.reset();
});

describe("FaultText", () => {
  it("prints redacted everywhere but reveal", () => {
    const text = new FaultText(WORDS);
    expect(text.reveal()).toBe(WORDS);
    for (const out of [String(text), `${text}`, JSON.stringify({ text }), inspect({ text }, { depth: 5 })]) {
      expect(out).not.toContain("Jane Donor");
      expect(out).toContain(FAULT_TEXT_REDACTED);
    }
  });

  it("joins each error's message and detail, and is null with no words", () => {
    expect(faultTextOf([{ Message: "A", Detail: "B" }, { Message: "C" }])?.reveal()).toBe("A: B\nC");
    expect(faultTextOf([{ Message: " " }, {}])).toBeNull();
  });

  it("keeps at most 2000 characters", () => {
    expect(new FaultText("x".repeat(5000)).reveal()).toHaveLength(2000);
  });
});

describe("the fault text is never logged", () => {
  it("not by a lane's failure report, its failure_kinded line, or a logged error", () => {
    const spies = [vi.spyOn(console, "warn").mockImplementation(() => {}), vi.spyOn(console, "error").mockImplementation(() => {}), vi.spyOn(console, "log").mockImplementation(() => {})];
    const reports: FailureReport[] = [];
    runtime.configure({ onFailure: (r) => void reports.push(r) });
    const err = refusal();
    const failure = postFailure(err);

    runtime.failed("posting", err, "expense 7");
    runtime.failed("posting", postFailureError(failure), "expense 7");
    console.error("qb_post_threw", { expenseId: "7" }, err);
    console.warn("[lane] post failed", failure);

    expect(reports).toEqual([
      { lane: "posting", kind: "data", status: 400, faultCodes: ["6240"], requestId: "t1", detail: "expense 7" },
      { lane: "posting", kind: "data", faultCodes: ["6240"], requestId: "t1", detail: "expense 7" },
    ]);
    expect(JSON.stringify(reports)).not.toContain("Jane Donor");
    expect(printed(spies)).not.toContain("Jane Donor");
    expect(faultTextColumn(failure)).toBe(WORDS);
  });
});
