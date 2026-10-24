import { describe, it, expect } from "vitest";
import { loadRelayConfig } from "./config.js";

// loadRelayConfig takes an explicit env bag (defaulting to process.env) so config
// parsing is testable without mutating the real environment.
const env = (over: Record<string, string> = {}) =>
  ({
    SNS_TOPIC_ARN: "arn:aws:sns:us-east-1:123456789012:monitoring-alerts",
    MONITORING_ENV: "dev",
    ...over,
  }) as NodeJS.ProcessEnv;

describe("loadRelayConfig — config-missing (negative paths)", () => {
  it("throws when SNS_TOPIC_ARN is absent (fail fast at startup, not at first publish)", () => {
    expect(() => loadRelayConfig({} as NodeJS.ProcessEnv)).toThrow();
  });

  it("throws when SNS_TOPIC_ARN is empty", () => {
    expect(() => loadRelayConfig({ SNS_TOPIC_ARN: "" } as NodeJS.ProcessEnv)).toThrow();
  });

  it("throws when MONITORING_ENV is absent (no silent fallback to dev)", () => {
    expect(() =>
      loadRelayConfig({ SNS_TOPIC_ARN: "arn:aws:sns:us-east-1:123456789012:monitoring-alerts" } as NodeJS.ProcessEnv),
    ).toThrow(/MONITORING_ENV/);
  });

  it("throws on a non-numeric RELAY_BATCH_LIMIT", () => {
    expect(() => loadRelayConfig(env({ RELAY_BATCH_LIMIT: "abc" }))).toThrow();
  });

  it("throws on a zero batch limit (must be positive)", () => {
    expect(() => loadRelayConfig(env({ RELAY_BATCH_LIMIT: "0" }))).toThrow();
  });

  it("throws on a negative batch limit", () => {
    expect(() => loadRelayConfig(env({ RELAY_BATCH_LIMIT: "-5" }))).toThrow();
  });

  it("throws on a fractional batch limit (must be an integer)", () => {
    expect(() => loadRelayConfig(env({ RELAY_BATCH_LIMIT: "10.5" }))).toThrow();
  });

  it("throws on a zero/negative RELAY_MAX_ATTEMPTS (must be positive)", () => {
    expect(() => loadRelayConfig(env({ RELAY_MAX_ATTEMPTS: "0" }))).toThrow();
    expect(() => loadRelayConfig(env({ RELAY_MAX_ATTEMPTS: "-1" }))).toThrow();
  });
});

describe("loadRelayConfig — defaults & coercion (positive paths)", () => {
  it("applies defaults when only the required vars are provided", () => {
    expect(loadRelayConfig(env())).toEqual({
      snsTopicArn: "arn:aws:sns:us-east-1:123456789012:monitoring-alerts",
      env: "dev",
      monitorName: "monitoring-relay",
      batchLimit: 50,
      maxAttempts: 5,
    });
  });

  it("coerces an explicit RELAY_MAX_ATTEMPTS", () => {
    expect(loadRelayConfig(env({ RELAY_MAX_ATTEMPTS: "8" })).maxAttempts).toBe(8);
  });

  it("coerces a numeric-string batch limit to a number", () => {
    expect(loadRelayConfig(env({ RELAY_BATCH_LIMIT: "10" })).batchLimit).toBe(10);
  });

  it("honors explicit env and monitor name", () => {
    const cfg = loadRelayConfig(env({ MONITORING_ENV: "prod", MONITOR_NAME: "relay-eu" }));
    expect(cfg.env).toBe("prod");
    expect(cfg.monitorName).toBe("relay-eu");
  });
});
