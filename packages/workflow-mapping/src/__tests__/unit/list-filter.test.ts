/** The receipt queue filter, read from the query. No database. */
import { describe, expect, it } from "vitest";
import { listFilter } from "../../routes";

const filter = (q: string) => listFilter(new URLSearchParams(q));

describe("listFilter", () => {
  it("reads comma-joined and repeated states", () => {
    expect(filter("state=pending_review,apply_failed&state=applying")).toEqual({ states: ["pending_review", "apply_failed", "applying"] });
  });

  it("reads repeated receipt ids", () => {
    expect(filter("receiptId=r-1&receiptId=r-2")).toEqual({ receiptIds: ["r-1", "r-2"] });
  });

  it("reads both together", () => {
    expect(filter("state=resolved&receiptId=r-1")).toEqual({ states: ["resolved"], receiptIds: ["r-1"] });
  });

  it("does not narrow when absent or empty", () => {
    expect(filter("")).toEqual({});
    expect(filter("state=&receiptId=")).toEqual({});
  });
});
