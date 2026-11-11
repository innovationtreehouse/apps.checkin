import { describe, it, expect } from "vitest";
import {
  throttleWaitMs,
  backoffCeilingMs,
  jitteredBackoffMs,
  retryAfterMs,
  MAX_DELAY_MS,
  MIN_THROTTLE_WAIT_MS,
  THROTTLE_BUFFER_MS,
} from "../../src/shopify/client.js";

describe("throttleWaitMs (Shopify's canonical formula)", () => {
  it("waits (requestedQueryCost - currentlyAvailable) / restoreRate, plus buffer", () => {
    // deficit 900 / 50 per s = 18s = 18000ms, + buffer
    const ms = throttleWaitMs({
      requestedQueryCost: 1000,
      throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 100, restoreRate: 50 },
    });
    expect(ms).toBe(18_000 + THROTTLE_BUFFER_MS);
  });

  it("floors at the 1s minimum when the bucket already has enough points", () => {
    const ms = throttleWaitMs({
      requestedQueryCost: 100,
      throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 900, restoreRate: 50 },
    });
    expect(ms).toBe(MIN_THROTTLE_WAIT_MS);
  });

  it("caps at MAX_DELAY_MS for an enormous deficit", () => {
    const ms = throttleWaitMs({
      requestedQueryCost: 100_000,
      throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 0, restoreRate: 50 },
    });
    expect(ms).toBe(MAX_DELAY_MS);
  });

  it("falls back to a flat 1s when cost info is missing or unusable", () => {
    expect(throttleWaitMs(undefined)).toBe(MIN_THROTTLE_WAIT_MS);
    expect(throttleWaitMs({ requestedQueryCost: 500 })).toBe(MIN_THROTTLE_WAIT_MS); // no throttleStatus
    expect(
      throttleWaitMs({ requestedQueryCost: 500, throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 0, restoreRate: 0 } }),
    ).toBe(MIN_THROTTLE_WAIT_MS); // restoreRate 0
  });
});

describe("backoffCeilingMs (deterministic exponential, capped)", () => {
  it("doubles each attempt from the 500ms base", () => {
    expect(backoffCeilingMs(1)).toBe(500);
    expect(backoffCeilingMs(2)).toBe(1_000);
    expect(backoffCeilingMs(5)).toBe(8_000);
  });

  it("is actually reachable and clamps at the cap (the old MAX_ATTEMPTS=6 made this dead)", () => {
    expect(backoffCeilingMs(6)).toBe(16_000);
    expect(backoffCeilingMs(7)).toBe(MAX_DELAY_MS); // 32000 -> clamped
    expect(backoffCeilingMs(8)).toBe(MAX_DELAY_MS);
  });
});

describe("jitteredBackoffMs (full jitter)", () => {
  it("returns 0 at the low end and the full ceiling at the high end", () => {
    expect(jitteredBackoffMs(3, () => 0)).toBe(0);
    // rand()=>0.9999 -> just under the ceiling
    expect(jitteredBackoffMs(3, () => 0.5)).toBe(1_000); // ceiling 2000 * 0.5
  });

  it("always stays within [0, ceiling] for any rand in [0,1)", () => {
    for (let attempt = 1; attempt <= 10; attempt++) {
      const ceiling = backoffCeilingMs(attempt);
      for (const r of [0, 0.25, 0.5, 0.75, 0.999999]) {
        const ms = jitteredBackoffMs(attempt, () => r);
        expect(ms).toBeGreaterThanOrEqual(0);
        expect(ms).toBeLessThanOrEqual(ceiling);
      }
    }
  });
});

describe("retryAfterMs", () => {
  it("parses seconds into milliseconds", () => {
    expect(retryAfterMs("2")).toBe(2_000);
    expect(retryAfterMs("0.5")).toBe(500);
  });

  it("clamps to the cap", () => {
    expect(retryAfterMs("300")).toBe(MAX_DELAY_MS); // 300s would otherwise be 5 minutes
  });

  it("returns null for absent or invalid values", () => {
    expect(retryAfterMs(null)).toBeNull();
    expect(retryAfterMs(undefined)).toBeNull();
    expect(retryAfterMs("")).toBeNull();
    expect(retryAfterMs("abc")).toBeNull();
    expect(retryAfterMs("-1")).toBeNull();
  });
});
