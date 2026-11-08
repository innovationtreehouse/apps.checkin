import { describe, expect, it } from "vitest";
import { FAULT_CODES, faultKind, isClosedPeriod, type FaultCodeTable } from "../faultCodes";
import * as pkg from "../index";

describe("FAULT_CODES", () => {
  it("is exported from the package", () => {
    expect(pkg.FAULT_CODES).toBe(FAULT_CODES);
  });

  it("keys every entry by a numeric code and describes it", () => {
    for (const [code, entry] of Object.entries(FAULT_CODES)) {
      expect(code).toMatch(/^\d+$/);
      expect(entry.description.trim()).not.toBe("");
    }
  });

  it("lists exactly the codes below, each with its own test", () => {
    expect(Object.keys(FAULT_CODES).sort()).toEqual(["6210"]);
  });

  it("6210 is closed books, and its refusal keeps the status rule's kind", () => {
    expect(FAULT_CODES["6210"].kind).toBe("closed");
    expect(isClosedPeriod(["6210"])).toBe(true);
    expect(faultKind(400, ["6210"])).toBe("data");
    expect(faultKind(403, ["6210"])).toBe("connection");
    expect(faultKind(500, ["6210"])).toBe("system");
  });
});

describe("faultKind", () => {
  it("sorts by status when no code is in the table", () => {
    expect(faultKind(401, [])).toBe("connection");
    expect(faultKind(403, ["9999"])).toBe("connection");
    expect(faultKind(429, [])).toBe("system");
    expect(faultKind(503, [])).toBe("system");
    expect(faultKind(400, ["9999"])).toBe("data");
    expect(isClosedPeriod(["9999"])).toBe(false);
  });

  const table: FaultCodeTable = {
    "1": { kind: "settings", description: "stub settings" },
    "2": { kind: "data", description: "stub data" },
  };

  it("a classified code overrides the status rule on a 4xx", () => {
    expect(faultKind(403, ["1"], table)).toBe("settings");
    expect(faultKind(400, ["1"], table)).toBe("settings");
    expect(faultKind(403, ["2"], table)).toBe("data");
  });

  it("settings wins when a refusal carries a settings and a data code", () => {
    expect(faultKind(400, ["2", "1"], table)).toBe("settings");
  });

  it("a refused login, a rate limit and a server error keep the status rule's kind", () => {
    expect(faultKind(401, ["1"], table)).toBe("connection");
    expect(faultKind(429, ["1"], table)).toBe("system");
    expect(faultKind(500, ["1"], table)).toBe("system");
  });
});
