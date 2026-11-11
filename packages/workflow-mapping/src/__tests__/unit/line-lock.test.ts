import { describe, expect, it } from "vitest";
import { lineLockReason } from "../../lib/line-lock";

describe("lineLockReason", () => {
  it("leaves pending_review lines editable", () => {
    expect(lineLockReason({ state: "pending_review" })).toBeNull();
  });

  it.each(["applying", "apply_failed", "resolved"])("locks %s lines by state", (state) => {
    expect(lineLockReason({ state })).toBe(`Cannot edit lines of a receipt in state "${state}"`);
  });
});
