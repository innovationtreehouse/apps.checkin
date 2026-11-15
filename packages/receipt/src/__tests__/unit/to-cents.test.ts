import { describe, expect, it } from "vitest";
import { toCents } from "../../lib/schemas";

describe("toCents", () => {
  it("rounds as @checkin/money does", () => {
    expect(toCents("1.005")).toBe(101);
    expect(toCents("3.33")).toBe(333);
    expect(toCents("10")).toBe(1000);
    expect(toCents(1.005)).toBe(101);
  });

  it("reads a missing or non-numeric amount as 0", () => {
    expect(toCents(undefined)).toBe(0);
    expect(toCents("")).toBe(0);
    expect(toCents("abc")).toBe(0);
  });

  it("reads the number a string starts with", () => {
    expect(toCents("12.5x")).toBe(1250);
  });
});
