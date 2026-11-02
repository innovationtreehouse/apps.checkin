/** Finance's word on a QuickBooks retry — no database. */
import { describe, it, expect } from "vitest";
import { retryRefusal } from "../../services/holdService";

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
