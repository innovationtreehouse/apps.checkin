import { describe, expect, it } from "vitest";
import { latestOutcome, outcomeSteps } from "../../lib/purchaseOutcome";

describe("a finalized receipt's purchase outcome in words", () => {
  it("shows nothing on a receipt that is not finalized", () => {
    expect(outcomeSteps(null)).toEqual([]);
    expect(latestOutcome(undefined)).toBeNull();
  });

  it("says when the outcome could not be read", () => {
    expect(latestOutcome({ unavailable: true })).toMatchObject({ label: "Status unavailable" });
  });

  it("says when nothing downstream has taken the receipt yet", () => {
    expect(outcomeSteps({ receiving: null, money: null, gift: null })).toEqual([{ label: "Not yet sent to receiving", tone: "waiting", notes: [] }]);
  });

  it("lists receiving, then the money, with the approver's note on a rejected line", () => {
    const steps = outcomeSteps({ receiving: "received", money: { status: "line_rejected", notes: ["Not a program cost"] }, gift: null });
    expect(steps.map((s) => s.label)).toEqual(["Received", "Line rejected"]);
    expect(steps[1]).toMatchObject({ tone: "refused", notes: ["Not a program cost"] });
  });

  it("reads waiting on approval, complete, and backfill", () => {
    expect(latestOutcome({ receiving: "received", money: { status: "awaiting_approval", notes: [] }, gift: null })).toMatchObject({ label: "Waiting on approval", tone: "waiting" });
    expect(latestOutcome({ receiving: "received", money: { status: "complete", notes: [] }, gift: null })).toMatchObject({ label: "Complete", tone: "done" });
    expect(latestOutcome({ receiving: "received", money: { status: "backfill", notes: [] }, gift: null })).toMatchObject({ label: "Complete (booked earlier)", tone: "done" });
  });

  it("reads an in-kind gift's decision", () => {
    expect(latestOutcome({ receiving: "received", money: null, gift: "accepted" })).toMatchObject({ label: "Gift accepted", tone: "done" });
    expect(latestOutcome({ receiving: "received", money: null, gift: "refused" })).toMatchObject({ label: "Gift refused", tone: "refused" });
  });
});
