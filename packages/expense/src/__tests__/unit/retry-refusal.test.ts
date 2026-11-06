/** Finance's word on a QuickBooks retry or book — no database. */
import { describe, it, expect } from "vitest";
import { retryRefusal } from "../../services/holdService";
import { bookRefusal } from "../../lib/expense-qb-poster";

describe("bookRefusal", () => {
  it("names what keeps a booked expense from posting when it now waits on finance", () => {
    expect(bookRefusal("NEEDS_FINANCE", "unpostable", "the expense has no receipt date")).toMatchObject({
      status: 409,
      message: "Not booked: the expense has no receipt date; the expense now waits as NEEDS_FINANCE",
    });
  });

  it("falls back to the state alone when no reason was recorded", () => {
    expect(bookRefusal("NEEDS_FINANCE", "needs_finance", null)).toMatchObject({ status: 409, message: "Not booked: the expense now waits as NEEDS_FINANCE" });
  });

  it.each([
    ["UNBOOKED", "waiting", 409, "a sign-off is missing"],
    ["UNBOOKED", "queued", 409, "closed books"],
    ["POST_FAILED", "failed", 503, "QuickBooks failed while booking"],
    ["AMBIGUOUS", "queued", 409, "now waits as AMBIGUOUS"],
  ] as const)("keeps the %s / %s answer", (state, outcome, status, words) => {
    expect(bookRefusal(state, outcome, null)).toMatchObject({ status, message: expect.stringContaining(words) });
  });
});

describe("retryRefusal", () => {
  it.each(["posted", "matched"] as const)("refuses nothing when the retry %s", (outcome) => {
    expect(retryRefusal(outcome)).toBeNull();
  });

  it("says nothing was sent while QuickBooks is not connected", () => {
    expect(retryRefusal("unbound")).toMatchObject({ status: 503, message: "QuickBooks isn't connected, so nothing was sent" });
  });

  it.each([
    ["failed", 503, "QuickBooks failed again"],
    ["waiting", 409, "Not posted yet"],
    ["queued", 409, "waits for finance"],
    ["not_sent", 409, "test-data"],
    ["needs_finance", 409, "still needs finance"],
    ["no_class", 409, "QuickBooks Class"],
    ["unpostable", 409, "own data"],
  ] as const)("names where a %s retry leaves the expense", (outcome, status, words) => {
    expect(retryRefusal(outcome)).toMatchObject({ status, message: expect.stringContaining(words) });
  });
});
