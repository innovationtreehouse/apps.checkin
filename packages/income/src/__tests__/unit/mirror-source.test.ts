import { describe, it, expect } from "vitest";
import { mirrorPayoutStatus, mirrorSource } from "../../contract";

describe("mirrorSource", () => {
  it.each([
    ["HAND_LOADED", "hand_loaded"],
    ["BACKFILL", "api"],
    ["INCREMENTAL", "api"],
    [null, "api"],
  ] as const)("maps %s to %s", (raw, expected) => {
    expect(mirrorSource(raw)).toBe(expected);
  });

  it("returns null for TEST_LOADED, so the adapter drops the row", () => {
    expect(mirrorSource("TEST_LOADED")).toBeNull();
  });
});

describe("mirrorPayoutStatus", () => {
  it.each([
    ["PAID", "paid"],
    ["paid", "paid"],
    ["IN_TRANSIT", "in_transit"],
    ["FAILED", "failed"],
  ])("normalises %s to %s", (raw, expected) => {
    expect(mirrorPayoutStatus(raw)).toBe(expected);
  });
});
