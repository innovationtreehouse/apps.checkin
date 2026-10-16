/**
 * The heartbeat sink wiring (monitoring.ts): whether a sink is built at all, and —
 * the part that actually matters — that the built sink forwards a RunHeartbeat to
 * recordHeartbeat with the fields mapped through, the service default (and overrides)
 * applied, and the sink disabled (never defaulted) when MONITORING_ENV is missing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { recordHeartbeat } = vi.hoisted(() => ({ recordHeartbeat: vi.fn() }));
vi.mock("@inventory/monitoring-db", () => ({
  prisma: { __fake: true },
  recordHeartbeat,
}));
const { logError } = vi.hoisted(() => ({ logError: vi.fn() }));
vi.mock("@inventory/s-ingest-core", () => ({ logger: { error: logError } }));

import { buildHeartbeatSink } from "../../src/monitoring.js";

beforeEach(() => vi.clearAllMocks());

describe("buildHeartbeatSink", () => {
  it("returns undefined when monitoring is not configured (no MONITORING_DATABASE_URL)", () => {
    // Without a monitoring DB the service simply doesn't push — local dev / inject stay quiet.
    expect(buildHeartbeatSink({})).toBeUndefined();
  });

  it("disables the sink and logs an error when MONITORING_DATABASE_URL is set but MONITORING_ENV is not", () => {
    const sink = buildHeartbeatSink({ MONITORING_DATABASE_URL: "postgresql://localhost/monitoring" } as NodeJS.ProcessEnv);
    expect(sink).toBeUndefined();
    expect(logError).toHaveBeenCalledWith(expect.stringContaining("MONITORING_ENV is required"), {});
  });

  it("returns a sink function when MONITORING_DATABASE_URL and MONITORING_ENV are set", () => {
    const sink = buildHeartbeatSink({
      MONITORING_DATABASE_URL: "postgresql://localhost/monitoring",
      MONITORING_ENV: "dev",
    } as NodeJS.ProcessEnv);
    expect(typeof sink).toBe("function");
  });

  it("forwards the heartbeat to recordHeartbeat with the default service", async () => {
    const sink = buildHeartbeatSink({
      MONITORING_DATABASE_URL: "postgresql://localhost/monitoring",
      MONITORING_ENV: "dev",
    } as NodeJS.ProcessEnv)!;
    const finishedAt = new Date("2026-06-10T00:00:00Z");
    await sink({ storeId: "s", kind: "INCREMENTAL", status: "COMPLETED", finishedAt, error: null } as never);

    expect(recordHeartbeat).toHaveBeenCalledWith(expect.anything(), {
      service: "shopify-read",
      env: "dev",
      status: "COMPLETED",
      finishedAt,
      error: null,
      kind: "INCREMENTAL",
    });
  });

  it("honors SERVICE_NAME and MONITORING_ENV", async () => {
    const sink = buildHeartbeatSink({
      MONITORING_DATABASE_URL: "postgresql://localhost/monitoring",
      SERVICE_NAME: "shopify-read-eu",
      MONITORING_ENV: "prod",
    } as NodeJS.ProcessEnv)!;
    await sink({ storeId: "s", kind: "BACKFILL", status: "FAILED", finishedAt: new Date(), error: "boom" } as never);

    expect(recordHeartbeat).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ service: "shopify-read-eu", env: "prod", status: "FAILED", error: "boom", kind: "BACKFILL" }),
    );
  });
});
