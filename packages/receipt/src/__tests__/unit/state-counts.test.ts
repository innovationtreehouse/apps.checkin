import { describe, expect, it } from "vitest";
import { RECEIPT_STATES, tallyReceiptStates } from "../../services/stateCounts";

const row = (state: string, n: number) => ({ state, _count: { _all: n } });

describe("receipt state tally", () => {
  it("lists every machine state", () => {
    expect([...RECEIPT_STATES].sort()).toEqual([
      "auto_upload", "discarded", "duplicate_flagged", "financial_review", "flow_error", "ocr_failed",
      "receipt_finalized", "rejected", "submitter_review", "uploaded", "validation_failed",
    ]);
  });

  it("shows a zero for every state when there are no receipts", () => {
    const out = tallyReceiptStates([]);
    expect(out.map((s) => s.state)).toEqual(RECEIPT_STATES);
    expect(out.every((s) => s.count === 0)).toBe(true);
  });

  it("counts present states, labels them, and keeps absent ones at zero", () => {
    const out = tallyReceiptStates([row("financial_review", 3), row("receipt_finalized", 2)]);
    expect(out.find((s) => s.state === "financial_review")).toEqual({ state: "financial_review", label: "Finance review", count: 3 });
    expect(out.find((s) => s.state === "receipt_finalized")?.count).toBe(2);
    expect(out.find((s) => s.state === "rejected")?.count).toBe(0);
  });

  it("appends a stored state the machine does not define, labelled by its code", () => {
    const out = tallyReceiptStates([row("legacy_state", 1)]);
    expect(out.at(-1)).toEqual({ state: "legacy_state", label: "legacy_state", count: 1 });
    expect(out).toHaveLength(RECEIPT_STATES.length + 1);
  });
});
