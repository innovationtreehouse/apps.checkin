import { describe, expect, it } from "vitest";
import { parseClient, parseGrant } from "./secret";

describe("secret parsing", () => {
  it("accepts complete secrets", () => {
    expect(parseClient(JSON.stringify({ clientId: "i", clientSecret: "s" }))).toEqual({ clientId: "i", clientSecret: "s" });
    expect(parseGrant(JSON.stringify({ refreshToken: "r", mailbox: "m" }))).toEqual({ refreshToken: "r", mailbox: "m" });
  });

  it("rejects a secret missing a field, naming the field", () => {
    expect(() => parseGrant(JSON.stringify({ refreshToken: "value-r" }))).toThrow(/mailbox/);
  });

  it("rejects a non-object", () => {
    expect(() => parseClient("null")).toThrow(/JSON object/);
  });
});
