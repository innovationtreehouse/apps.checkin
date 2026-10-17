/**
 * Integration: runRelay against a REAL monitoring Postgres. SNS (publishAlert) and telemetry
 * are mocked; @checkin/monitoring-db is real, so the claim→publish→mark drain, its
 * oldest-first ordering, the SENT/PENDING persistence, and the failed-row retry semantics are
 * all exercised end to end. Skipped unless MONITORING_DATABASE_URL is set (no Docker → skip).
 */
import { it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

const m = vi.hoisted(() => ({
  publishAlert: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  newCorrelationId: vi.fn(() => "corr-1"),
  emitMonitorHeartbeat: vi.fn(),
  emitDbUnreachable: vi.fn(),
}));

// Stub only publishAlert (no real SNS); keep the REAL isPermanentSnsError classifier so the
// failed-publish path classifies correctly (a plain Error → transient → row stays PENDING).
vi.mock("../../src/sns.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/sns.js")>();
  return { ...actual, publishAlert: m.publishAlert };
});
vi.mock("@checkin/telemetry", () => ({
  logger: m.logger,
  newCorrelationId: m.newCorrelationId,
  emitMonitorHeartbeat: m.emitMonitorHeartbeat,
  emitDbUnreachable: m.emitDbUnreachable,
  emitServiceError: vi.fn(),
}));

import { runRelay } from "../../src/relay.js";
import { handler } from "../../src/handler.js";
import { OutboxStatus } from "@checkin/monitoring-db";
import { runIfDb, prisma, resetTables, seedAlert } from "./db.js";

const cfg = {
  snsTopicArn: "arn:aws:sns:us-east-1:123456789012:monitoring-alerts",
  env: "test",
  monitorName: "monitoring-relay",
  batchLimit: 50,
};

const statusOf = (id: bigint) => prisma.outbox.findUniqueOrThrow({ where: { id } });

runIfDb("relay drain (integration)", () => {
  beforeAll(() => {
    m.publishAlert.mockResolvedValue(undefined);
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    vi.clearAllMocks();
    m.publishAlert.mockResolvedValue(undefined);
    await resetTables();
  });

  it("publishes every PENDING alert oldest-first, marks them SENT, and reports the count", async () => {
    const a = await seedAlert({ service: "svc-a", createdAt: new Date("2026-06-01T00:00:00Z") });
    const b = await seedAlert({ service: "svc-b", createdAt: new Date("2026-06-02T00:00:00Z") });

    const result = await runRelay(cfg);

    expect(result).toEqual({ delivered: 2, failed: 0, deadLettered: 0 });
    // Oldest-first claim → publish order.
    expect(m.publishAlert.mock.calls.map((c) => c[1].service)).toEqual(["svc-a", "svc-b"]);
    expect(m.publishAlert).toHaveBeenCalledWith(cfg.snsTopicArn, expect.objectContaining({ service: "svc-a" }));
    expect((await statusOf(a)).status).toBe(OutboxStatus.SENT);
    expect((await statusOf(b)).status).toBe(OutboxStatus.SENT);
    expect(m.emitMonitorHeartbeat).toHaveBeenCalledTimes(1);
  });

  it("an empty outbox is a clean no-op that still asserts liveness", async () => {
    const result = await runRelay(cfg);

    expect(result).toEqual({ delivered: 0, failed: 0, deadLettered: 0 });
    expect(m.publishAlert).not.toHaveBeenCalled();
    expect(m.emitMonitorHeartbeat).toHaveBeenCalledTimes(1);
  });

  it("a failed publish leaves its row PENDING (attempts++, lastError) while the rest deliver; a re-run drains it", async () => {
    const good = await seedAlert({ service: "good", createdAt: new Date("2026-06-01T00:00:00Z") });
    const bad = await seedAlert({ service: "bad", createdAt: new Date("2026-06-02T00:00:00Z") });
    // Fail only the "bad" alert's publish.
    m.publishAlert.mockImplementation(async (_topic: string, alert: { service: string }) => {
      if (alert.service === "bad") throw new Error("AuthorizationError: not allowed to publish");
    });

    const first = await runRelay(cfg);

    expect(first).toEqual({ delivered: 1, failed: 1, deadLettered: 0 });
    expect((await statusOf(good)).status).toBe(OutboxStatus.SENT);
    const badRow = await statusOf(bad);
    expect(badRow.status).toBe(OutboxStatus.PENDING); // retryable
    expect(badRow.attempts).toBe(1);
    expect(badRow.lastError).toContain("AuthorizationError");

    // Next run: publish now succeeds → the still-PENDING row is re-claimed and delivered.
    m.publishAlert.mockResolvedValue(undefined);
    const second = await runRelay(cfg);

    expect(second).toEqual({ delivered: 1, failed: 0, deadLettered: 0 }); // only the previously-failed row remained
    expect((await statusOf(bad)).status).toBe(OutboxStatus.SENT);
  });

  it("never claims more than the batch limit in one run", async () => {
    await seedAlert({ service: "p1", createdAt: new Date("2026-06-01T00:00:00Z") });
    await seedAlert({ service: "p2", createdAt: new Date("2026-06-02T00:00:00Z") });
    await seedAlert({ service: "p3", createdAt: new Date("2026-06-03T00:00:00Z") });

    const result = await runRelay({ ...cfg, batchLimit: 2 });

    expect(result).toEqual({ delivered: 2, failed: 0, deadLettered: 0 });
    expect(m.publishAlert).toHaveBeenCalledTimes(2);
    // One row is left for the next run.
    expect(await prisma.outbox.count({ where: { status: OutboxStatus.PENDING } })).toBe(1);
  });
});

// ── Tier 3 e2e: the actual Lambda entry, env → loadRelayConfig → runRelay → real DB ───────
runIfDb("relay handler (e2e)", () => {
  const ENV_KEYS = ["SNS_TOPIC_ARN", "MONITORING_ENV", "MONITOR_NAME", "RELAY_BATCH_LIMIT"] as const;
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
    m.publishAlert.mockResolvedValue(undefined);
    process.env.SNS_TOPIC_ARN = "arn:aws:sns:us-east-1:123456789012:monitoring-alerts";
    process.env.MONITORING_ENV = "test";
    process.env.MONITOR_NAME = "monitoring-relay";
    delete process.env.RELAY_BATCH_LIMIT; // exercise the default
    await resetTables();
  });

  it("loads config from the environment and drains the real outbox end to end", async () => {
    const id = await seedAlert({ service: "e2e-svc" });

    const result = await handler();

    expect(result).toEqual({ delivered: 1, failed: 0, deadLettered: 0 });
    expect(m.publishAlert).toHaveBeenCalledWith(
      "arn:aws:sns:us-east-1:123456789012:monitoring-alerts",
      expect.objectContaining({ service: "e2e-svc" }),
    );
    expect((await prisma.outbox.findUniqueOrThrow({ where: { id } })).status).toBe(OutboxStatus.SENT);
  });

  it("a malformed environment (missing SNS_TOPIC_ARN) fails fast at config load", async () => {
    delete process.env.SNS_TOPIC_ARN;
    await expect(handler()).rejects.toThrow(); // zod validation, before any DB work
  });
});
