/**
 * Integration: runWatchdog against a REAL monitoring Postgres. Telemetry is mocked;
 * @checkin/monitoring-db is real, so readServiceHeartbeats, the freshness/erroring
 * evaluation, and the transactional recordIncident write (health_event + outbox, plus the
 * renotify-window alert dedup) are exercised end to end. Skipped unless MONITORING_DATABASE_URL
 * is set (no Docker → skip).
 */
import { it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

const m = vi.hoisted(() => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  newCorrelationId: vi.fn(() => "corr-1"),
  emitServiceError: vi.fn(),
  emitDbUnreachable: vi.fn(),
  emitMonitorHeartbeat: vi.fn(),
}));

vi.mock("@checkin/telemetry", () => ({
  logger: m.logger,
  newCorrelationId: m.newCorrelationId,
  emitServiceError: m.emitServiceError,
  emitDbUnreachable: m.emitDbUnreachable,
  emitMonitorHeartbeat: m.emitMonitorHeartbeat,
}));

import { runWatchdog } from "../../src/watchdog.js";
import { handler } from "../../src/handler.js";
// Cross-function contract: the REAL s-read heartbeat sink writes into the same monitoring DB
// the watchdog reads. These packages move together, so the relative import is intentional —
// it proves both sides agree on the (service, env, status, finishedAt) heartbeat shape.
import { buildHeartbeatSink } from "../../../s-read-function/src/monitoring.js";
import type { WatchdogConfig } from "../../src/registry.js";
import { runIfDb, prisma, resetTables, beat } from "./db.js";

const STALE_AFTER = 3600; // 1h
const ago = (s: number) => new Date(Date.now() - s * 1000);

function cfg(services: Array<{ service: string; staleAfterSeconds?: number }>, over: Partial<WatchdogConfig> = {}): WatchdogConfig {
  return {
    env: "test",
    monitorName: "monitoring-watchdog",
    renotifyAfterSeconds: 3600,
    services: services.map((s) => ({ service: s.service, staleAfterSeconds: s.staleAfterSeconds ?? STALE_AFTER })),
    ...over,
  };
}

const events = (service: string) => prisma.healthEvent.findMany({ where: { service, env: "test" } });
const alerts = (service: string) => prisma.outbox.findMany({ where: { service, env: "test" } });

runIfDb("watchdog evaluation (integration)", () => {
  beforeAll(() => {});
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    vi.clearAllMocks();
    await resetTables();
  });

  it("healthy service (recent success): no incident, no health_event, liveness emitted", async () => {
    await beat("shopify-read", "COMPLETED", ago(30));

    const result = await runWatchdog(cfg([{ service: "shopify-read" }]));

    expect(result).toEqual({ checked: 1, incidents: 0 });
    expect(await events("shopify-read")).toHaveLength(0);
    expect(m.emitServiceError).not.toHaveBeenCalled();
    expect(m.emitMonitorHeartbeat).toHaveBeenCalledTimes(1);
  });

  it("stale service (old success): writes a CRITICAL STALE health_event + an outbox alert", async () => {
    await beat("shopify-read", "COMPLETED", ago(100_000)); // ~27h ago, well past 1h threshold

    const result = await runWatchdog(cfg([{ service: "shopify-read" }]));

    expect(result).toEqual({ checked: 1, incidents: 1 });
    const he = await events("shopify-read");
    expect(he).toHaveLength(1);
    expect(he[0]).toMatchObject({ kind: "STALE", severity: "CRITICAL" });
    expect(await alerts("shopify-read")).toHaveLength(1);
    expect(m.emitServiceError).toHaveBeenCalledWith("shopify-read", "test", { correlationId: "corr-1" });
  });

  it("erroring service (fresh success, newer failure): writes a WARNING ERRORING incident", async () => {
    await beat("shopify-read", "COMPLETED", ago(60));
    await beat("shopify-read", "FAILED", ago(20), "connection reset");

    const result = await runWatchdog(cfg([{ service: "shopify-read" }]));

    expect(result).toEqual({ checked: 1, incidents: 1 });
    const he = await events("shopify-read");
    expect(he[0]).toMatchObject({ kind: "ERRORING", severity: "WARNING" });
    expect((he[0].detail as Record<string, unknown>).error).toBe("connection reset");
  });

  it("never-reported service (no heartbeat row): stale with a null age", async () => {
    const result = await runWatchdog(cfg([{ service: "ghost" }]));

    expect(result).toEqual({ checked: 1, incidents: 1 });
    const he = await events("ghost");
    expect(he[0]).toMatchObject({ kind: "STALE", severity: "CRITICAL" });
    expect((he[0].detail as Record<string, unknown>).ageSeconds).toBeNull();
  });

  it("renotify window dedups the alert across ticks: a 2nd run appends the health_event but suppresses the outbox", async () => {
    await beat("shopify-read", "COMPLETED", ago(100_000));

    await runWatchdog(cfg([{ service: "shopify-read" }]));
    await runWatchdog(cfg([{ service: "shopify-read" }])); // same stale state, within renotify window

    // Append-only diagnosis history grows every tick...
    expect(await events("shopify-read")).toHaveLength(2);
    // ...but the pager is not re-fired: exactly one outbox alert.
    expect(await alerts("shopify-read")).toHaveLength(1);
    // Both runs still emitted the per-service metric (the floor is unconditional).
    expect(m.emitServiceError).toHaveBeenCalledTimes(2);
  });

  it("mixed fleet in one pass: only unhealthy services get incidents, counts are correct", async () => {
    await beat("healthy-svc", "COMPLETED", ago(30));
    await beat("stale-svc", "COMPLETED", ago(100_000));

    const result = await runWatchdog(cfg([{ service: "healthy-svc" }, { service: "stale-svc" }, { service: "ghost-svc" }]));

    expect(result).toEqual({ checked: 3, incidents: 2 }); // stale-svc + ghost-svc
    expect(await events("healthy-svc")).toHaveLength(0);
    expect(await events("stale-svc")).toHaveLength(1);
    expect(await events("ghost-svc")).toHaveLength(1);
  });
});

// ── Tier 3 e2e: the actual Lambda entry, env → loadWatchdogConfig → runWatchdog → real DB ──
runIfDb("watchdog handler (e2e)", () => {
  const ENV_KEYS = ["MONITORING_SERVICES", "MONITORING_ENV", "MONITOR_NAME", "RENOTIFY_AFTER_SECONDS"] as const;
  const saved: Record<string, string | undefined> = {};

  beforeAll(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
  });
  afterAll(async () => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.MONITORING_SERVICES = JSON.stringify([{ service: "shopify-read", staleAfterSeconds: 3600 }]);
    process.env.MONITORING_ENV = "test";
    process.env.MONITOR_NAME = "monitoring-watchdog";
    delete process.env.RENOTIFY_AFTER_SECONDS; // exercise the default
    await resetTables();
  });

  it("parses the MONITORING_SERVICES registry from env and opens a real incident for a stale service", async () => {
    await beat("shopify-read", "COMPLETED", ago(100_000));

    const result = await handler();

    expect(result).toEqual({ checked: 1, incidents: 1 });
    expect((await events("shopify-read"))[0]).toMatchObject({ kind: "STALE", severity: "CRITICAL" });
  });

  it("malformed MONITORING_SERVICES (not JSON) fails fast at config load", async () => {
    process.env.MONITORING_SERVICES = "{not json";
    await expect(handler()).rejects.toThrow(); // before any DB work
  });
});

// ── Tier 3 cross-function contract: s-read's REAL heartbeat sink → watchdog handler ────────
runIfDb("cross-function: s-read heartbeat → watchdog (e2e)", () => {
  const ENV_KEYS = ["MONITORING_SERVICES", "MONITORING_ENV", "MONITOR_NAME", "RENOTIFY_AFTER_SECONDS"] as const;
  const saved: Record<string, string | undefined> = {};

  // s-read's sink reads SERVICE_NAME/MONITORING_ENV to form the (service, env) key. Pin both
  // to what the watchdog registry below expects so the two sides line up on the same row.
  const sink = buildHeartbeatSink({
    MONITORING_DATABASE_URL: process.env.MONITORING_DATABASE_URL,
    SERVICE_NAME: "shopify-read",
    MONITORING_ENV: "test",
  } as NodeJS.ProcessEnv);

  beforeAll(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
  });
  afterAll(async () => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.MONITORING_SERVICES = JSON.stringify([{ service: "shopify-read", staleAfterSeconds: 3600 }]);
    process.env.MONITORING_ENV = "test";
    process.env.MONITOR_NAME = "monitoring-watchdog";
    delete process.env.RENOTIFY_AFTER_SECONDS;
    await resetTables();
  });

  it("the sink is built when MONITORING_DATABASE_URL is configured", () => {
    expect(sink).toBeTypeOf("function");
  });

  it("a fresh COMPLETED heartbeat from s-read makes the watchdog report the service healthy", async () => {
    // s-read finishes an incremental run and pushes its freshness via its own sink…
    await sink!({ status: "COMPLETED", finishedAt: ago(30), error: null, kind: "INCREMENTAL" });

    // …and the watchdog, reading the same monitoring DB, sees it as healthy.
    const result = await handler();

    expect(result).toEqual({ checked: 1, incidents: 0 });
    expect(await events("shopify-read")).toHaveLength(0);
  });

  it("a stale last-success from s-read makes the watchdog open a CRITICAL STALE incident", async () => {
    await sink!({ status: "COMPLETED", finishedAt: ago(100_000), error: null, kind: "INCREMENTAL" });

    const result = await handler();

    expect(result).toEqual({ checked: 1, incidents: 1 });
    expect((await events("shopify-read"))[0]).toMatchObject({ kind: "STALE", severity: "CRITICAL" });
  });

  it("a failure newer than the last success surfaces as ERRORING across the contract", async () => {
    await sink!({ status: "COMPLETED", finishedAt: ago(120), error: null, kind: "INCREMENTAL" });
    await sink!({ status: "FAILED", finishedAt: ago(30), error: "shopify 503", kind: "INCREMENTAL" });

    const result = await handler();

    expect(result).toEqual({ checked: 1, incidents: 1 });
    const he = await events("shopify-read");
    expect(he[0]).toMatchObject({ kind: "ERRORING", severity: "WARNING" });
    expect((he[0].detail as Record<string, unknown>).error).toBe("shopify 503");
  });
});
