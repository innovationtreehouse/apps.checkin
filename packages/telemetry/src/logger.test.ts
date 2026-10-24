import { describe, it, expect, vi, afterEach } from "vitest";
import { logger, newCorrelationId } from "./index.js";

/** Spy on all three console sinks at once and parse back what each received. */
function capture() {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const parse = (spy: typeof log) => spy.mock.calls.map((c) => JSON.parse(String(c[0])));
  return {
    log: () => parse(log),
    warn: () => parse(warn),
    error: () => parse(error),
  };
}

afterEach(() => vi.restoreAllMocks());

describe("logger — level → console sink routing", () => {
  it("info goes to console.log only", () => {
    const c = capture();
    logger.info("hello");
    expect(c.log()).toHaveLength(1);
    expect(c.warn()).toHaveLength(0);
    expect(c.error()).toHaveLength(0);
    expect(c.log()[0]).toMatchObject({ level: "info", msg: "hello" });
  });

  it("warn goes to console.warn only", () => {
    const c = capture();
    logger.warn("careful");
    expect(c.warn()).toHaveLength(1);
    expect(c.log()).toHaveLength(0);
    expect(c.error()).toHaveLength(0);
    expect(c.warn()[0]).toMatchObject({ level: "warn", msg: "careful" });
  });

  it("error goes to console.error only", () => {
    const c = capture();
    logger.error("boom");
    expect(c.error()).toHaveLength(1);
    expect(c.log()).toHaveLength(0);
    expect(c.warn()).toHaveLength(0);
    expect(c.error()[0]).toMatchObject({ level: "error", msg: "boom" });
  });
});

describe("logger — line shape", () => {
  it("writes one JSON object per call with an ISO-8601 timestamp", () => {
    const c = capture();
    logger.info("x");
    const [line] = c.log();
    expect(typeof line.time).toBe("string");
    expect(line.time).toBe(new Date(line.time).toISOString());
    expect(Number.isNaN(Date.parse(line.time))).toBe(false);
  });

  it("merges arbitrary structured fields into the line", () => {
    const c = capture();
    logger.info("ingest done", { service: "shopify-read", count: 42, ok: true });
    const [line] = c.log();
    expect(line.service).toBe("shopify-read");
    expect(line.count).toBe(42);
    expect(line.ok).toBe(true);
  });

  it("works with no fields argument", () => {
    const c = capture();
    expect(() => logger.info("bare")).not.toThrow();
    expect(c.log()[0]).toMatchObject({ level: "info", msg: "bare" });
  });
});

describe("logger — Error serialization", () => {
  it("serializes an Error field to {name, message, stack} (not an empty object)", () => {
    const c = capture();
    const err = new TypeError("kaboom");
    logger.error("failed", { err });
    const [line] = c.error();
    expect(line.err.name).toBe("TypeError");
    expect(line.err.message).toBe("kaboom");
    expect(typeof line.err.stack).toBe("string");
    expect(line.err.stack.length).toBeGreaterThan(0);
  });

  it("serializes a nested Error, not just a top-level one", () => {
    const c = capture();
    logger.error("failed", { cause: { inner: new Error("deep") } });
    const [line] = c.error();
    expect(line.cause.inner.name).toBe("Error");
    expect(line.cause.inner.message).toBe("deep");
  });

  it("leaves non-Error fields untouched alongside an Error", () => {
    const c = capture();
    logger.error("failed", { err: new Error("x"), attempt: 3 });
    const [line] = c.error();
    expect(line.attempt).toBe(3);
    expect(line.err.message).toBe("x");
  });

  it("redacts secrets in an Error's message and stack", () => {
    const c = capture();
    const err = new Error("GET https://shop.example.com/orders.json?access_token=abc123 as jane@example.org");
    logger.error("failed", { err });
    const raw = String(vi.mocked(console.error).mock.calls[0][0]);
    expect(raw).not.toContain("abc123");
    expect(raw).not.toContain("jane@example.org");
    const [line] = c.error();
    expect(line.err.message).toBe("GET [url] as [email]");
    expect(line.err.stack).toContain("GET [url] as [email]");
  });

  it("redacts secrets in msg and any top-level string field, including unlisted ones", () => {
    const c = capture();
    logger.error("SHOPIFY_API_KEY=abc123def rejected", {
      err: "connect postgresql://app:hunter2pass@db/app failed",
      detail: "CRON_SECRET=s3cr3tvalue",
    });
    const raw = String(vi.mocked(console.error).mock.calls[0][0]);
    expect(raw).not.toContain("abc123def");
    expect(raw).not.toContain("hunter2pass");
    expect(raw).not.toContain("s3cr3tvalue");
    const [line] = c.error();
    expect(line.msg).toBe("SHOPIFY_API_KEY=[redacted] rejected");
    expect(line.err).toBe("connect postgresql://app:[redacted]@db/app failed");
    expect(line.detail).toBe("CRON_SECRET=[redacted]");
    expect(line.level).toBe("error");
  });

  it("keeps id-shaped *Id fields (UUID, digits, short slug) but redacts an opaque token in one", () => {
    const c = capture();
    const correlationId = newCorrelationId();
    const opaque = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";
    logger.info("x", { correlationId, outboxId: "4821", storeId: "main-store", fooId: opaque });
    const [line] = c.log();
    expect(line.correlationId).toBe(correlationId);
    expect(line.outboxId).toBe("4821");
    expect(line.storeId).toBe("main-store");
    expect(line.fooId).toBe("[redacted]");
  });

  it("omits the stack when the Error has none", () => {
    const c = capture();
    const err = new Error("no stack");
    err.stack = undefined;
    logger.error("failed", { err });
    expect(c.error()[0].err).toEqual({ name: "Error", message: "no stack" });
  });
});

describe("newCorrelationId", () => {
  it("returns a v4-shaped UUID", () => {
    expect(newCorrelationId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("returns a fresh value each call", () => {
    const ids = new Set(Array.from({ length: 100 }, () => newCorrelationId()));
    expect(ids.size).toBe(100);
  });
});
