/**
 * Orchestration tests for runWatchdog — the layer between the pure deciders (covered in
 * watchdog.test.ts) and their side effects: metric emission, the transactional incident
 * write, the advisory lock, and the liveness heartbeat. The two @checkin packages are
 * mocked so these run with no database, matching the fleet's no-DB unit-test convention.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// vi.hoisted so the mock fn handles exist before the (hoisted) vi.mock factories run.
const m = vi.hoisted(() => ({
  recordIncident: vi.fn(),
  readServiceHeartbeats: vi.fn(),
  withAdvisoryLock: vi.fn(),
  emitServiceError: vi.fn(),
  emitDbUnreachable: vi.fn(),
  emitMonitorHeartbeat: vi.fn(),
  newCorrelationId: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@checkin/monitoring-db", () => ({
  prisma: { __brand: "prisma" },
  recordIncident: m.recordIncident,
  readServiceHeartbeats: m.readServiceHeartbeats,
  withAdvisoryLock: m.withAdvisoryLock,
  ConcurrentRunError: class ConcurrentRunError extends Error {
    lockKey: string;
    constructor(lockKey: string) {
      super(`advisory lock "${lockKey}" is already held by another run`);
      this.name = "ConcurrentRunError";
      this.lockKey = lockKey;
    }
  },
  IncidentKind: { STALE: "STALE", ERRORING: "ERRORING" },
  Severity: { CRITICAL: "CRITICAL", WARNING: "WARNING" },
}));

vi.mock("@checkin/telemetry", () => ({
  logger: m.logger,
  newCorrelationId: m.newCorrelationId,
  emitServiceError: m.emitServiceError,
  emitDbUnreachable: m.emitDbUnreachable,
  emitMonitorHeartbeat: m.emitMonitorHeartbeat,
}));

import { runWatchdog } from "./watchdog.js";
import { ConcurrentRunError, prisma } from "@checkin/monitoring-db";
import type { WatchdogConfig } from "./registry.js";
import type { ServiceFreshness } from "@checkin/monitoring-db";

const NOW = Date.now();
const secsAgo = (s: number) => new Date(NOW - s * 1000);

function cfg(services: WatchdogConfig["services"], overrides: Partial<WatchdogConfig> = {}): WatchdogConfig {
  return {
    env: "prod",
    monitorName: "monitoring-watchdog",
    renotifyAfterSeconds: 3600,
    services,
    ...overrides,
  };
}

const entry = (service: string, staleAfterSeconds = 7200) => ({ service, staleAfterSeconds });

function heartbeats(map: Record<string, ServiceFreshness>): Map<string, ServiceFreshness> {
  return new Map(Object.entries(map));
}

const fresh: ServiceFreshness = { lastFinishedAt: secsAgo(60), latestFailure: null }; // 60s ago, well inside 7200
const stale: ServiceFreshness = { lastFinishedAt: secsAgo(100_000), latestFailure: null }; // ~27h ago
const erroring: ServiceFreshness = {
  lastFinishedAt: secsAgo(60), // recent success → not stale
  latestFailure: { failedAt: secsAgo(30), error: "boom" }, // newer failure → erroring
};

beforeEach(() => {
  vi.clearAllMocks();
  // Default: lock is acquired, run the protected work; read returns no rows; write succeeds.
  m.withAdvisoryLock.mockImplementation(
    async (_key: string, fn: () => Promise<unknown>) => fn(),
  );
  m.readServiceHeartbeats.mockResolvedValue(new Map());
  m.recordIncident.mockResolvedValue({ healthEventId: 1n, outboxId: 2n, suppressed: false });
  m.newCorrelationId.mockReturnValue("corr-1");
});

// ── Recommendation 1: per-service verdict → side-effect wiring ────────────────────────────
describe("runWatchdog — verdict to side-effect wiring", () => {
  it("healthy service: no metric, no incident, heartbeat emitted, counts clean", async () => {
    m.readServiceHeartbeats.mockResolvedValue(heartbeats({ "shopify-read": fresh }));

    const result = await runWatchdog(cfg([entry("shopify-read")]));

    expect(m.emitServiceError).not.toHaveBeenCalled();
    expect(m.recordIncident).not.toHaveBeenCalled();
    expect(m.emitMonitorHeartbeat).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ checked: 1, incidents: 0 });
  });

  it("stale service: serviceError + a CRITICAL STALE incident", async () => {
    m.readServiceHeartbeats.mockResolvedValue(heartbeats({ "shopify-read": stale }));

    const result = await runWatchdog(cfg([entry("shopify-read")]));

    expect(m.emitServiceError).toHaveBeenCalledWith("shopify-read", "prod", { correlationId: "corr-1" });
    expect(m.recordIncident).toHaveBeenCalledTimes(1);
    const input = m.recordIncident.mock.calls[0][1];
    expect(input).toMatchObject({ service: "shopify-read", env: "prod", kind: "STALE", severity: "CRITICAL" });
    expect(input.subject).toContain("stale");
    expect(input.summary).toBeTruthy();
    expect(result).toEqual({ checked: 1, incidents: 1 });
  });

  it("erroring service (fresh, but newer failure): serviceError + a WARNING ERRORING incident", async () => {
    m.readServiceHeartbeats.mockResolvedValue(heartbeats({ "shopify-read": erroring }));

    const result = await runWatchdog(cfg([entry("shopify-read")]));

    expect(m.emitServiceError).toHaveBeenCalledWith("shopify-read", "prod", { correlationId: "corr-1" });
    const input = m.recordIncident.mock.calls[0][1];
    expect(input).toMatchObject({ service: "shopify-read", kind: "ERRORING", severity: "WARNING" });
    expect(input.detail).toMatchObject({ error: "boom" });
    expect(result).toEqual({ checked: 1, incidents: 1 });
  });

  it("never-reported service (no heartbeat row): stale with a null age", async () => {
    // Empty map → the service falls through to NEVER_REPORTED.
    const result = await runWatchdog(cfg([entry("shopify-read")]));

    expect(m.emitServiceError).toHaveBeenCalledTimes(1);
    const input = m.recordIncident.mock.calls[0][1];
    expect(input).toMatchObject({ kind: "STALE", severity: "CRITICAL" });
    expect(input.detail).toMatchObject({ ageSeconds: null });
    expect(result).toEqual({ checked: 1, incidents: 1 });
  });

  it("passes the monitoring-db prisma client into the read and the write", async () => {
    m.readServiceHeartbeats.mockResolvedValue(heartbeats({ "shopify-read": stale }));

    await runWatchdog(cfg([entry("shopify-read")]));

    expect(m.readServiceHeartbeats).toHaveBeenCalledWith(prisma, "prod", ["shopify-read"]);
    expect(m.recordIncident.mock.calls[0][0]).toBe(prisma);
  });
});

// ── Recommendation 2: runWatchdog control flow + the liveness floor ───────────────────────
describe("runWatchdog — control flow and liveness", () => {
  it("monitoring DB unreachable: emits dbUnreachable, rethrows, and WITHHOLDS the heartbeat", async () => {
    const boom = new Error("ECONNREFUSED");
    m.readServiceHeartbeats.mockRejectedValue(boom);

    await expect(runWatchdog(cfg([entry("shopify-read")]))).rejects.toThrow("ECONNREFUSED");

    expect(m.emitDbUnreachable).toHaveBeenCalledWith("monitoring-watchdog", "prod", { error: "ECONNREFUSED" });
    expect(m.emitMonitorHeartbeat).not.toHaveBeenCalled();
  });

  it("concurrent run: skips cleanly WITHOUT a heartbeat (the lock-holder asserts liveness)", async () => {
    m.withAdvisoryLock.mockRejectedValue(new ConcurrentRunError("watchdog:prod"));

    const result = await runWatchdog(cfg([entry("shopify-read")]));

    expect(result).toEqual({ checked: 0, incidents: 0, skipped: true });
    // No heartbeat on skip: chronic overlap (a stuck holder checking nothing) must not read as alive.
    expect(m.emitMonitorHeartbeat).not.toHaveBeenCalled();
    expect(m.emitDbUnreachable).not.toHaveBeenCalled();
  });

  it("successful run emits exactly one heartbeat, after the work completes", async () => {
    m.readServiceHeartbeats.mockResolvedValue(heartbeats({ "shopify-read": stale }));

    await runWatchdog(cfg([entry("shopify-read")]));

    expect(m.emitMonitorHeartbeat).toHaveBeenCalledTimes(1);
    // Heartbeat is the last signal: it fires after the per-service metric.
    expect(m.emitMonitorHeartbeat.mock.invocationCallOrder[0]).toBeGreaterThan(
      m.emitServiceError.mock.invocationCallOrder[0],
    );
  });
});

// ── Recommendation 3: safeRecord resilience + the "metric is the floor" ordering ──────────
describe("runWatchdog — incident-write resilience and emission order", () => {
  it("metric fires BEFORE the incident write (the floor survives a monitoring-DB outage)", async () => {
    m.readServiceHeartbeats.mockResolvedValue(heartbeats({ "shopify-read": stale }));

    await runWatchdog(cfg([entry("shopify-read")]));

    expect(m.emitServiceError.mock.invocationCallOrder[0]).toBeLessThan(
      m.recordIncident.mock.invocationCallOrder[0],
    );
  });

  it("incident write failure is swallowed and logged; the run still completes and counts the incident", async () => {
    m.readServiceHeartbeats.mockResolvedValue(heartbeats({ "shopify-read": stale }));
    m.recordIncident.mockRejectedValue(new Error("monitoring DB down"));

    const result = await runWatchdog(cfg([entry("shopify-read")]));

    expect(m.emitServiceError).toHaveBeenCalledTimes(1); // metric already fired
    expect(m.logger.error).toHaveBeenCalled(); // failure logged, not thrown
    expect(m.emitMonitorHeartbeat).toHaveBeenCalledTimes(1); // run completed
    expect(result).toEqual({ checked: 1, incidents: 1 });
  });

  it("suppressed (deduped) alert: no throw, logged, still counts as an incident", async () => {
    m.readServiceHeartbeats.mockResolvedValue(heartbeats({ "shopify-read": stale }));
    m.recordIncident.mockResolvedValue({ healthEventId: 1n, outboxId: null, suppressed: true });

    const result = await runWatchdog(cfg([entry("shopify-read")]));

    expect(m.emitServiceError).toHaveBeenCalledTimes(1);
    expect(m.logger.info).toHaveBeenCalled();
    expect(result).toEqual({ checked: 1, incidents: 1 });
  });
});

// ── Recommendation 4: partial-fleet behavior ──────────────────────────────────────────────
describe("runWatchdog — partial fleet", () => {
  it("mixed fleet: one metric per unhealthy service, healthy ones untouched, counts correct", async () => {
    m.readServiceHeartbeats.mockResolvedValue(
      heartbeats({ "shopify-read": stale, "square-read": erroring, "clover-read": fresh }),
    );

    const result = await runWatchdog(
      cfg([entry("shopify-read"), entry("square-read"), entry("clover-read")]),
    );

    expect(result).toEqual({ checked: 3, incidents: 2 });
    expect(m.emitServiceError).toHaveBeenCalledTimes(2);
    const services = m.emitServiceError.mock.calls.map((c) => c[0]);
    expect(services).toEqual(["shopify-read", "square-read"]);
    expect(services).not.toContain("clover-read");
  });

  it("STALE takes precedence when a service is BOTH stale and has a newer failure", async () => {
    // No recent success (stale) AND a failure newer than that — only the CRITICAL STALE fires.
    m.readServiceHeartbeats.mockResolvedValue(
      heartbeats({ "shopify-read": { lastFinishedAt: secsAgo(100_000), latestFailure: { failedAt: secsAgo(50), error: "boom" } } }),
    );

    const result = await runWatchdog(cfg([entry("shopify-read")]));

    expect(m.recordIncident).toHaveBeenCalledTimes(1);
    expect(m.recordIncident.mock.calls[0][1]).toMatchObject({ kind: "STALE", severity: "CRITICAL" });
    expect(result).toEqual({ checked: 1, incidents: 1 });
  });

  it("sanitizes newline-bearing service error text out of the operator-facing summary", async () => {
    m.readServiceHeartbeats.mockResolvedValue(
      heartbeats({
        "shopify-read": { lastFinishedAt: secsAgo(60), latestFailure: { failedAt: secsAgo(30), error: "line1\nline2\rinjected" } },
      }),
    );

    await runWatchdog(cfg([entry("shopify-read")]));

    const input = m.recordIncident.mock.calls[0][1];
    expect(input.kind).toBe("ERRORING");
    expect(input.summary).not.toMatch(/[\r\n]/); // no raw control chars reach the alert
    expect(input.summary).toContain("line1 line2 injected");
  });

  it("one service's incident-write failure does not abort the rest of the fleet", async () => {
    m.readServiceHeartbeats.mockResolvedValue(
      heartbeats({ "shopify-read": stale, "square-read": stale }),
    );
    m.recordIncident.mockRejectedValueOnce(new Error("write failed for first service"));

    const result = await runWatchdog(cfg([entry("shopify-read"), entry("square-read")]));

    expect(m.emitServiceError).toHaveBeenCalledTimes(2); // both still evaluated
    expect(m.recordIncident).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ checked: 2, incidents: 2 });
  });
});

// ── Edge cases: error-excerpt truncation and the lock-release callback ─────────────────────
describe("runWatchdog — edge cases", () => {
  it("erroring summary truncates the last error to 300 chars, but the detail keeps it whole", async () => {
    const longError = "E".repeat(500);
    m.readServiceHeartbeats.mockResolvedValue(
      heartbeats({
        "shopify-read": { lastFinishedAt: secsAgo(60), latestFailure: { failedAt: secsAgo(30), error: longError } },
      }),
    );

    await runWatchdog(cfg([entry("shopify-read")]));

    const input = m.recordIncident.mock.calls[0][1];
    // Human-facing summary excerpt is capped at 300 chars...
    expect(input.summary).toContain("E".repeat(300));
    expect(input.summary).not.toContain("E".repeat(301));
    // ...while the structured detail retains the full error for forensics.
    expect(input.detail.error).toBe(longError);
  });
});
