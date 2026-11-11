/** The inventory log and applied-delta filters, read from the query. No database. */
import { describe, expect, it } from "vitest";
import { deltaFilter, logFilter } from "../../routes/ledgers";

const sp = (q: string) => new URLSearchParams(q);

describe("logFilter", () => {
  it("narrows to one receipt", () => {
    expect(logFilter(sp("receiptId=r-42&page=2"))).toEqual({ receiptId: "r-42" });
  });

  it("lists every change without a receipt", () => {
    expect(logFilter(sp(""))).toEqual({});
    expect(logFilter(sp("receiptId="))).toEqual({});
  });
});

describe("deltaFilter", () => {
  it("narrows to failed or applied applies", () => {
    expect(deltaFilter(sp("status=failed"))).toEqual({ status: "failed" });
    expect(deltaFilter(sp("status=applied"))).toEqual({ status: "applied" });
  });

  it("ignores a missing or unknown status", () => {
    expect(deltaFilter(sp(""))).toEqual({});
    expect(deltaFilter(sp("status=pending"))).toEqual({});
  });
});
