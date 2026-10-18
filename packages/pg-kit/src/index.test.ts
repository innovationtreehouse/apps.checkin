/**
 * Unit tests for the Postgres kit, with no database: a fake pg Client answers the try-lock,
 * and `createLazyPrisma` is driven with a stub builder. Cross-session lock exclusion against
 * real Postgres lives in the monitoring-db and s-ingest-core integration tiers.
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

import {
  createLazyPrisma,
  isUniqueConstraintError,
  isRecordNotFoundError,
  retryOnUniqueRace,
  withAdvisoryLock,
  ConcurrentRunError,
} from "./index";

const ENV = "PG_KIT_TEST_DATABASE_URL";
const KEY = "__pgKitTestPrisma";

class FakeClient {
  constructor(public readonly url: string) {}
  ping() {
    return this.url;
  }
}

describe("createLazyPrisma", () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>)[KEY];
    delete process.env[ENV];
  });

  it("builds nothing until first use, then builds once from the env var", () => {
    const build = vi.fn((url: string) => new FakeClient(url));
    const { prisma, getPrisma } = createLazyPrisma(ENV, build, KEY);
    expect(build).not.toHaveBeenCalled();

    process.env[ENV] = "postgresql://env-host/db";
    expect(prisma.ping()).toBe("postgresql://env-host/db");
    expect(getPrisma()).toBe(getPrisma());
    expect(build).toHaveBeenCalledOnce();
  });

  it("prefers an explicit connection string and memoizes on globalThis", () => {
    process.env[ENV] = "postgresql://env-host/db";
    const { getPrisma } = createLazyPrisma(ENV, (url) => new FakeClient(url), KEY);
    const c = getPrisma("postgresql://explicit-host/db");
    expect(c.url).toBe("postgresql://explicit-host/db");
    expect((globalThis as Record<string, unknown>)[KEY]).toBe(c);
  });

  it("throws naming the env var when no URL is available", () => {
    const { getPrisma } = createLazyPrisma(ENV, (url) => new FakeClient(url), KEY);
    expect(() => getPrisma()).toThrow(new RegExp(ENV));
  });
});

describe("Prisma error detection", () => {
  it("matches by code, whichever client instance threw it", () => {
    expect(isUniqueConstraintError({ code: "P2002" })).toBe(true);
    expect(isUniqueConstraintError({ code: "P2025" })).toBe(false);
    expect(isUniqueConstraintError(null)).toBe(false);
    expect(isRecordNotFoundError({ code: "P2025" })).toBe(true);
    expect(isRecordNotFoundError("P2025")).toBe(false);
  });

  it("retryOnUniqueRace retries once on P2002 and rethrows anything else", async () => {
    const op = vi.fn().mockRejectedValueOnce({ code: "P2002" }).mockResolvedValueOnce("row");
    await expect(retryOnUniqueRace(op)).resolves.toBe("row");
    expect(op).toHaveBeenCalledTimes(2);

    const boom = new Error("boom");
    await expect(retryOnUniqueRace(vi.fn().mockRejectedValue(boom))).rejects.toBe(boom);
  });
});

describe("withAdvisoryLock", () => {
  const URL = "postgresql://lock-test/db";

  beforeEach(() => {
    vi.clearAllMocks();
    client.connect.mockResolvedValue(undefined);
    client.end.mockResolvedValue(undefined);
  });

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
    await expect(run).rejects.toMatchObject({ lockKey: "mykey", name: "ConcurrentRunError" });
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

  it("refuses to run without a connection string, naming the setting", async () => {
    await expect(withAdvisoryLock("k", vi.fn(), "", "SOME_DATABASE_URL")).rejects.toThrow(/SOME_DATABASE_URL/);
    expect(client.connect).not.toHaveBeenCalled();
  });
});
