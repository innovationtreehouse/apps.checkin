import { describe, expect, it } from "vitest";
import { describeKept } from "../../lib/duplicateGroup";

describe("describeKept", () => {
  it("names the kept receipt by its id alone", () => {
    expect(describeKept("3f2a9c1e-0000-4000-8000-000000000001")).toBe("receipt 3f2a9c1e-0000-4000-8000-000000000001");
  });
});
