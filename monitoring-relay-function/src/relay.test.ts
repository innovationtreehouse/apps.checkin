import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PendingAlert } from "@inventory/monitoring-db";

// ── Mocks ─────────────────────────────────────────────────────────────────────
// The relay's three collaborators are all side-effecting (Postgres, SNS, CloudWatch
// EMF), so we stub them and assert the orchestration: what gets published, what gets
// acked, and which metrics fire on every exit path.

vi.mock("@inventory/monitoring-db", () => {
  // Real-enough class so relay.ts's `err instanceof ConcurrentRunError` works.
  class ConcurrentRunError extends Error {
    lockKey: string;
    constructor(key: string) {
      super(`advisory lock "${key}" is already held by another run`);
      this.name = "ConcurrentRunError";
      this.lockKey = key;
    }
  }
  return {
    prisma: { __brand: "prisma" },
    claimPending: vi.fn(),
    markSent: vi.fn(),
    markFailed: vi.fn(),
    countDead: vi.fn(),
    withAdvisoryLock: vi.fn(),
    ConcurrentRunError,
  };
});

// isPermanentSnsError is the real classifier; publishAlert is stubbed.
vi.mock("./sns.js", async (importActual) => {
  const actual = await importActual<typeof import("./sns.js")>();
  return { ...actual, publishAlert: vi.fn() };
});

vi.mock("@inventory/telemetry", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  newCorrelationId: vi.fn(() => "corr-test"),
  emitMonitorHeartbeat: vi.fn(),
  emitDbUnreachable: vi.fn(),
  emitServiceError: vi.fn(),
}));

import { runRelay } from "./relay.js";
import {
  prisma,
  claimPending,
  markSent,
  markFailed,
  countDead,
  withAdvisoryLock,
  ConcurrentRunError,
} from "@inventory/monitoring-db";
import { publishAlert } from "./sns.js";
import { emitMonitorHeartbeat, emitDbUnreachable, emitServiceError } from "@inventory/telemetry";

const cfg = {
  snsTopicArn: "arn:aws:sns:us-east-1:123456789012:monitoring-alerts",
  env: "prod",
  monitorName: "monitoring-relay",
  batchLimit: 50,
  maxAttempts: 5,
};

function makeAlert(over: Partial<PendingAlert> = {}): PendingAlert {
  return {
    id: 1n,
    healthEventId: 42n,
    service: "shopify-read",
    env: "prod",
    severity: "CRITICAL",
    subject: "subj",
    summary: "body",
    correlationId: "abc-123",
    attempts: 0,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: the lock is free, so withAdvisoryLock just runs the drain.
  vi.mocked(withAdvisoryLock).mockImplementation(
    async (_key: string, fn: () => Promise<unknown>) => fn(),
  );
  vi.mocked(claimPending).mockResolvedValue([]);
  vi.mocked(publishAlert).mockResolvedValue(undefined);
  vi.mocked(markSent).mockResolvedValue(undefined);
  vi.mocked(markFailed).mockResolvedValue(undefined);
  vi.mocked(countDead).mockResolvedValue(0);
});

// ── Item 5: happy path, empty outbox, batch passthrough ─────────────────────────
describe("runRelay — delivery (positive paths)", () => {
  it("publishes each pending row then marks it sent, returning the delivered count", async () => {
    const a1 = makeAlert({ id: 1n });
    const a2 = makeAlert({ id: 2n, service: "shopify-ingest" });
    vi.mocked(claimPending).mockResolvedValue([a1, a2]);

    const result = await runRelay(cfg);

    expect(result).toEqual({ delivered: 2, failed: 0, deadLettered: 0 });
    expect(publishAlert).toHaveBeenCalledWith(cfg.snsTopicArn, a1);
    expect(publishAlert).toHaveBeenCalledWith(cfg.snsTopicArn, a2);
    expect(markSent).toHaveBeenCalledWith(prisma, a1.id);
    expect(markSent).toHaveBeenCalledWith(prisma, a2.id);
  });

  it("marks a row sent only AFTER its publish succeeds (ordering)", async () => {
    vi.mocked(claimPending).mockResolvedValue([makeAlert({ id: 7n })]);

    await runRelay(cfg);

    expect(vi.mocked(publishAlert).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(markSent).mock.invocationCallOrder[0],
    );
  });

  it("emits its heartbeat with the monitor name on a successful run", async () => {
    vi.mocked(claimPending).mockResolvedValue([makeAlert()]);

    await runRelay(cfg);

    expect(emitMonitorHeartbeat).toHaveBeenCalledWith(cfg.monitorName, cfg.env);
    expect(emitDbUnreachable).not.toHaveBeenCalled();
  });

  it("empty outbox: publishes nothing but still asserts liveness", async () => {
    vi.mocked(claimPending).mockResolvedValue([]);

    const result = await runRelay(cfg);

    expect(result).toEqual({ delivered: 0, failed: 0, deadLettered: 0 });
    expect(publishAlert).not.toHaveBeenCalled();
    expect(markSent).not.toHaveBeenCalled();
    expect(emitMonitorHeartbeat).toHaveBeenCalledWith(cfg.monitorName, cfg.env);
  });

  it("passes the configured batch limit through to claimPending", async () => {
    await runRelay({ ...cfg, batchLimit: 17 });

    expect(claimPending).toHaveBeenCalledWith(prisma, 17);
  });
});

// ── Item 1: idempotency / no-data-loss on publish failure ───────────────────────
describe("runRelay — publish failure (idempotency, negative paths)", () => {
  it("a failed publish marks the row failed, never marks it sent, and counts it failed", async () => {
    const a1 = makeAlert({ id: 5n });
    vi.mocked(claimPending).mockResolvedValue([a1]);
    vi.mocked(publishAlert).mockRejectedValue(new Error("SNS AccessDenied"));

    const result = await runRelay(cfg);

    expect(result).toEqual({ delivered: 0, failed: 1, deadLettered: 0 });
    expect(markFailed).toHaveBeenCalledWith(prisma, a1.id, "SNS AccessDenied", {
      attempts: 0,
      maxAttempts: 5,
      permanent: false,
    });
    expect(markSent).not.toHaveBeenCalled();
  });

  it("partial batch failure: continues past the failed row, sending the rest", async () => {
    const a1 = makeAlert({ id: 1n });
    const a2 = makeAlert({ id: 2n });
    const a3 = makeAlert({ id: 3n });
    vi.mocked(claimPending).mockResolvedValue([a1, a2, a3]);
    vi.mocked(publishAlert)
      .mockResolvedValueOnce(undefined) // a1 ok
      .mockRejectedValueOnce(new Error("throttled")) // a2 fails
      .mockResolvedValueOnce(undefined); // a3 ok

    const result = await runRelay(cfg);

    expect(result).toEqual({ delivered: 2, failed: 1, deadLettered: 0 });
    expect(markSent).toHaveBeenCalledWith(prisma, a1.id);
    expect(markSent).toHaveBeenCalledWith(prisma, a3.id);
    expect(markSent).not.toHaveBeenCalledWith(prisma, a2.id);
    expect(markFailed).toHaveBeenCalledWith(prisma, a2.id, "throttled", {
      attempts: 0,
      maxAttempts: 5,
      permanent: false,
    });
  });

  it("a failing markFailed write is swallowed and does not crash the run", async () => {
    vi.mocked(claimPending).mockResolvedValue([makeAlert({ id: 9n })]);
    vi.mocked(publishAlert).mockRejectedValue(new Error("boom"));
    vi.mocked(markFailed).mockRejectedValue(new Error("ack write also down"));

    const result = await runRelay(cfg);

    expect(result).toEqual({ delivered: 0, failed: 1, deadLettered: 0 });
    expect(emitMonitorHeartbeat).toHaveBeenCalledWith(cfg.monitorName, cfg.env);
  });
});

// ── DLQ: dead-letter on permanent / exhausted failure + unhealthy reporting ──────
describe("runRelay — dead-letter handling", () => {
  it("a permanent SNS error dead-letters the row (permanent verdict to markFailed)", async () => {
    const a1 = makeAlert({ id: 5n, attempts: 0 });
    vi.mocked(claimPending).mockResolvedValue([a1]);
    const permErr = Object.assign(new Error("InvalidParameter: attribute too long"), {
      name: "InvalidParameterException",
    });
    vi.mocked(publishAlert).mockRejectedValue(permErr);

    await runRelay(cfg);

    expect(markFailed).toHaveBeenCalledWith(prisma, a1.id, expect.any(String), {
      attempts: 0,
      maxAttempts: 5,
      permanent: true,
    });
  });

  it("the final allowed attempt dead-letters via the maxAttempts budget", async () => {
    const a1 = makeAlert({ id: 5n, attempts: 4 }); // attempts+1 = 5 = maxAttempts
    vi.mocked(claimPending).mockResolvedValue([a1]);
    vi.mocked(publishAlert).mockRejectedValue(new Error("throttled"));

    await runRelay(cfg);

    expect(markFailed).toHaveBeenCalledWith(prisma, a1.id, "throttled", {
      attempts: 4,
      maxAttempts: 5,
      permanent: false,
    });
  });

  it("reports the relay UNHEALTHY (serviceError) when the dead-letter set is non-empty, still heartbeats", async () => {
    vi.mocked(claimPending).mockResolvedValue([]);
    vi.mocked(countDead).mockResolvedValue(3);

    const result = await runRelay(cfg);

    expect(result).toEqual({ delivered: 0, failed: 0, deadLettered: 3 });
    expect(emitServiceError).toHaveBeenCalledWith(cfg.monitorName, cfg.env, {
      deadCount: 3,
      reason: "outbox dead-letter non-empty",
    });
    expect(emitMonitorHeartbeat).toHaveBeenCalledWith(cfg.monitorName, cfg.env);
  });

  it("does NOT emit serviceError when the dead-letter set is empty", async () => {
    vi.mocked(claimPending).mockResolvedValue([makeAlert()]);
    vi.mocked(countDead).mockResolvedValue(0);

    await runRelay(cfg);

    expect(emitServiceError).not.toHaveBeenCalled();
  });
});

// ── Item 2: error / skip branches and the heartbeat-always invariant ────────────
describe("runRelay — lock & DB branches (negative paths)", () => {
  it("ConcurrentRunError: skips cleanly, publishes nothing, and does NOT emit a heartbeat", async () => {
    vi.mocked(withAdvisoryLock).mockRejectedValue(new ConcurrentRunError("relay-drain:prod"));

    const result = await runRelay(cfg);

    expect(result).toEqual({ delivered: 0, failed: 0, skipped: true });
    expect(publishAlert).not.toHaveBeenCalled();
    expect(emitDbUnreachable).not.toHaveBeenCalled();
    // The lock-holder heartbeats; a skip must not, so chronic overlap can't masquerade as alive.
    expect(emitMonitorHeartbeat).not.toHaveBeenCalled();
  });

  it("monitoring DB unreachable: emits dbUnreachable(service=monitoring-db) + heartbeat, then rethrows", async () => {
    vi.mocked(withAdvisoryLock).mockRejectedValue(new Error("connection refused"));

    await expect(runRelay(cfg)).rejects.toThrow("connection refused");

    expect(emitDbUnreachable).toHaveBeenCalledWith("monitoring-db", cfg.env, {
      err: "connection refused",
    });
    expect(emitMonitorHeartbeat).toHaveBeenCalledWith(cfg.monitorName, cfg.env);
    expect(publishAlert).not.toHaveBeenCalled();
  });
});
