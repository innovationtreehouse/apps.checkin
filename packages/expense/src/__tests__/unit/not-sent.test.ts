/** The expense page's line on why QuickBooks holds an expense back — no database. */
import { describe, it, expect } from "vitest";
import { NOT_SENT } from "../../lib/expense-constants";

describe("NOT_SENT", () => {
  it("says a NEEDS_FINANCE expense waits for finance without claiming posts kept failing", () => {
    // An expense whose own data cannot post reaches NEEDS_FINANCE with no attempt made.
    expect(NOT_SENT.NEEDS_FINANCE).toMatch(/finance/);
    expect(NOT_SENT.NEEDS_FINANCE).not.toMatch(/kept failing|account mapping/);
  });
});
