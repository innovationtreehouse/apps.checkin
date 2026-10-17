import { describe, expect, it } from "vitest";
import { parseCredentials } from "./secret";

const VALID = {
  clientId: "id", clientSecret: "s", accessToken: "a", refreshToken: "r", realmId: "1",
  obtainedAt: 1, expiresIn: 3600,
};

describe("parseCredentials", () => {
  it("accepts a complete secret", () => {
    expect(parseCredentials(JSON.stringify(VALID))).toEqual(VALID);
  });

  it("rejects a secret missing a field", () => {
    const { refreshToken: _omit, ...rest } = VALID;
    expect(() => parseCredentials(JSON.stringify(rest))).toThrow(/refreshToken/);
  });

  it("rejects a non-object", () => {
    expect(() => parseCredentials("null")).toThrow(/JSON object/);
  });
});
