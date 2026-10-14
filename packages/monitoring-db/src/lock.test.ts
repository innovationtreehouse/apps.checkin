/**
 * Unit tests for withAdvisoryLock. A fake pg Client answers the try-lock, so every branch runs
 * without a database. Cross-session exclusion against real Postgres lives in
 * test/integration/lock.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const client = vi.hoisted(() => ({
  connect: vi.fn(),
  query: vi.fn(),
  end: vi.fn(),
}));

vi.mock("pg", () => ({
  default: {
    Client: class {
      connect = client.connect;
      query = client.query;
      end = client.end;
    },
  },
}));

import { withAdvisoryLock, ConcurrentRunError } from "./lock.js";

const URL = "postgresql://lock-test/db";

beforeEach(() => {
  vi.clearAllMocks();
  client.connect.mockResolvedValue(undefined);
  client.end.mockResolvedValue(undefined);
});

describe("withAdvisoryLock", () => {
  it("takes the session lock on its own connection, runs fn, and closes the connection", async () => {
    client.query.mockResolvedValue({ rows: [{ locked: true }] });
    const fn = vi.fn().mockResolvedValue("ok");

    expect(await withAdvisoryLock("k", fn, URL)).toBe("ok");
    expect(client.query).toHaveBeenCalledOnce();
    expect(client.query.mock.calls[0][0]).toContain("pg_try_advisory_lock");
    expect(client.query.mock.calls[0][1]).toEqual(["k"]);
    expect(fn).toHaveBeenCalledOnce();
    expect(client.end).toHaveBeenCalledOnce();
  });

  it("throws ConcurrentRunError without running fn when the lock is held, and still closes", async () => {
    client.query.mockResolvedValue({ rows: [{ locked: false }] });
    const fn = vi.fn();

    const run = withAdvisoryLock("mykey", fn, URL);

    await expect(run).rejects.toBeInstanceOf(ConcurrentRunError);
    await expect(run).rejects.toMatchObject({ lockKey: "mykey" });
    expect(fn).not.toHaveBeenCalled();
    expect(client.end).toHaveBeenCalledOnce();
  });

  it("rethrows fn's error and closes the connection, which releases the lock", async () => {
    client.query.mockResolvedValue({ rows: [{ locked: true }] });

    await expect(withAdvisoryLock("k", vi.fn().mockRejectedValue(new Error("boom")), URL)).rejects.toThrow("boom");
    expect(client.end).toHaveBeenCalledOnce();
  });

  it("returns fn's result even when closing the connection fails", async () => {
    client.query.mockResolvedValue({ rows: [{ locked: true }] });
    client.end.mockRejectedValue(new Error("socket gone"));

    await expect(withAdvisoryLock("k", vi.fn().mockResolvedValue(7), URL)).resolves.toBe(7);
  });

  it("refuses to run without a connection string", async () => {
    await expect(withAdvisoryLock("k", vi.fn(), "")).rejects.toThrow(/MONITORING_DATABASE_URL/);
  });
});
