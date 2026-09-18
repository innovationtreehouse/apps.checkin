/**
 * Drift guard for the runtime client's env-read wiring.
 *
 * The integration tier reaches the database through the lazy `prisma`/`db` proxy, whose
 * env-read path (CATALOG_DATABASE_URL → pg adapter) is otherwise only exercised
 * implicitly. Without this test, renaming the env var or breaking the adapter wiring could
 * sail through green. This pins, with NO database:
 *   - the exact env var name is read and handed to the pg adapter,
 *   - an explicit connection string overrides the env var,
 *   - a missing URL fails loudly instead of constructing a broken client,
 *   - nothing is constructed at import (the singleton is lazy).
 *
 * The adapter + generated client are mocked, so this asserts construction args without
 * opening a connection — it runs in the plain unit tier (no Docker needed), and is NOT
 * describeDb-gated.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const adapterArgs: Array<{ connectionString?: string }> = [];

vi.mock("@prisma/adapter-pg", () => ({
  PrismaPg: class {
    constructor(opts: { connectionString?: string }) {
      adapterArgs.push(opts);
    }
  },
}));

vi.mock("@/generated/prisma/client", () => ({
  PrismaClient: class {
    constructor(public opts: unknown) {}
  },
  Prisma: { PrismaClientKnownRequestError: class {} },
}));

const ENV = "CATALOG_DATABASE_URL";
const CLIENT = "@/db";
let saved: string | undefined;

beforeEach(() => {
  saved = process.env[ENV];
  adapterArgs.length = 0;
  delete (globalThis as Record<string, unknown>).__gcPrisma;
  vi.resetModules();
});

afterEach(() => {
  if (saved === undefined) delete process.env[ENV];
  else process.env[ENV] = saved;
});

describe("getPrisma construction (env-read wiring)", () => {
  it("reads CATALOG_DATABASE_URL and hands it to the pg adapter", async () => {
    process.env[ENV] = "postgresql://sentinel-host/db";
    const { getPrisma } = await import(CLIENT);
    getPrisma();
    expect(adapterArgs).toEqual([{ connectionString: "postgresql://sentinel-host/db" }]);
  });

  it("throws a clear error when the var is unset and no url is passed", async () => {
    delete process.env[ENV];
    const { getPrisma } = await import(CLIENT);
    expect(() => getPrisma()).toThrow(/CATALOG_DATABASE_URL/);
  });

  it("prefers an explicit connection string over the env var", async () => {
    process.env[ENV] = "postgresql://env-host/db";
    const { getPrisma } = await import(CLIENT);
    getPrisma("postgresql://explicit-host/db");
    expect(adapterArgs).toEqual([{ connectionString: "postgresql://explicit-host/db" }]);
  });

  it("constructs nothing at import time (lazy singleton)", async () => {
    process.env[ENV] = "postgresql://not-read-until-first-use/db";
    await import(CLIENT);
    expect(adapterArgs).toEqual([]);
  });
});
