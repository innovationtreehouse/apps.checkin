import { describe, it, expect } from "vitest";
import { loadWatchdogConfig } from "./registry.js";

/** Build a minimal env object — loadWatchdogConfig reads only the keys the schema names. */
function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    MONITORING_SERVICES: '[{"service":"shopify-read","staleAfterSeconds":7200}]',
    MONITORING_ENV: "dev",
    ...overrides,
  };
}

describe("loadWatchdogConfig", () => {
  it("parses a valid services array and passes through env/monitor/renotify", () => {
    const cfg = loadWatchdogConfig(
      env({
        MONITORING_SERVICES:
          '[{"service":"shopify-read","staleAfterSeconds":7200},{"service":"square-read","staleAfterSeconds":3600}]',
        MONITORING_ENV: "prod",
        MONITOR_NAME: "wd",
        RENOTIFY_AFTER_SECONDS: "600",
      }),
    );
    expect(cfg.env).toBe("prod");
    expect(cfg.monitorName).toBe("wd");
    expect(cfg.renotifyAfterSeconds).toBe(600);
    expect(cfg.services).toEqual([
      { service: "shopify-read", staleAfterSeconds: 7200 },
      { service: "square-read", staleAfterSeconds: 3600 },
    ]);
  });

  it("throws when MONITORING_ENV is absent (no silent fallback to dev)", () => {
    expect(() =>
      loadWatchdogConfig({ MONITORING_SERVICES: '[{"service":"shopify-read","staleAfterSeconds":7200}]' }),
    ).toThrow(/MONITORING_ENV/);
  });

  it("applies defaults for monitor name and renotify window", () => {
    const cfg = loadWatchdogConfig(env());
    expect(cfg.monitorName).toBe("monitoring-watchdog");
    expect(cfg.renotifyAfterSeconds).toBe(3600);
  });

  it("coerces RENOTIFY_AFTER_SECONDS from a string to a number", () => {
    const cfg = loadWatchdogConfig(env({ RENOTIFY_AFTER_SECONDS: "900" }));
    expect(cfg.renotifyAfterSeconds).toBe(900);
  });

  it("rejects a missing MONITORING_SERVICES", () => {
    expect(() => loadWatchdogConfig({})).toThrow();
  });

  it("rejects MONITORING_SERVICES that is not valid JSON", () => {
    expect(() => loadWatchdogConfig(env({ MONITORING_SERVICES: "{not json" }))).toThrow(/not valid JSON/);
  });

  it("rejects an empty services array", () => {
    expect(() => loadWatchdogConfig(env({ MONITORING_SERVICES: "[]" }))).toThrow(/at least one service/);
  });

  it("rejects an entry with a blank service name", () => {
    expect(() =>
      loadWatchdogConfig(env({ MONITORING_SERVICES: '[{"service":"","staleAfterSeconds":7200}]' })),
    ).toThrow();
  });

  it("rejects a non-positive staleAfterSeconds", () => {
    expect(() =>
      loadWatchdogConfig(env({ MONITORING_SERVICES: '[{"service":"shopify-read","staleAfterSeconds":0}]' })),
    ).toThrow();
  });

  it("rejects a non-integer staleAfterSeconds", () => {
    expect(() =>
      loadWatchdogConfig(env({ MONITORING_SERVICES: '[{"service":"shopify-read","staleAfterSeconds":1.5}]' })),
    ).toThrow();
  });
});
