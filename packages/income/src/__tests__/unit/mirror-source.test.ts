import { describe, it, expect } from "vitest";
import { mirrorSource } from "../../contract";

describe("mirrorSource", () => {
  it.each([
    ["HAND_LOADED", "hand_loaded"],
    ["TEST_LOADED", "hand_loaded"],
    ["BACKFILL", "api"],
    ["INCREMENTAL", "api"],
    [null, "api"],
  ] as const)("maps %s to %s", (raw, expected) => {
    expect(mirrorSource(raw)).toBe(expected);
  });
});
