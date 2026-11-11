import { describe, expect, it } from "vitest";
import { stateLabel } from "../../lib/stateLabels";

describe("a received receipt's state label", () => {
  it("says how many lines are still on backorder on a resolved receipt", () => {
    expect(stateLabel("resolved", 2)).toBe("Received, 2 on backorder");
  });

  it("reads Resolved once nothing is on backorder", () => {
    expect(stateLabel("resolved", 0)).toBe("Resolved");
  });

  it("ignores the count before the receipt is resolved, and shows an unknown state as is", () => {
    expect(stateLabel("applying", 3)).toBe("Applying");
    expect(stateLabel("mystery", 1)).toBe("mystery");
  });
});
