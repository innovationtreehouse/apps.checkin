/**
 * pgGlobalSetup is the reusable vitest globalSetup every Postgres package wires in. It boots
 * a container, migrates it, `provide`s the URL, and returns a teardown that stops it — and,
 * critically, must NOT throw when Docker is unreachable (it warns, provides undefined, and the
 * consuming package's gate skips its integration suites). The container + migrate boundary is
 * mocked so both the happy lifecycle and the no-Docker path are asserted without Docker.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const m = vi.hoisted(() => ({ startPostgres: vi.fn(), applyMigrations: vi.fn() }));
vi.mock("./container.js", () => ({ startPostgres: m.startPostgres }));
vi.mock("./migrate.js", () => ({ applyMigrations: m.applyMigrations }));

import { pgGlobalSetup } from "./globalSetup.js";

const opts = { migrateCwd: "/pkg", envVar: "FOO_DATABASE_URL", provideKey: "fooUrl" };

// The suite itself may run under PG_TEST_HARNESS=off; each test sets the switch it needs.
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("PG_TEST_HARNESS", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("pgGlobalSetup", () => {
  it("boots, migrates, provides the url, and returns a teardown that stops the container", async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    m.startPostgres.mockResolvedValue({ url: "postgres://container", stop });
    const provide = vi.fn();

    const teardown = await pgGlobalSetup(opts)({ provide });

    expect(m.applyMigrations).toHaveBeenCalledWith({ migrateCwd: "/pkg", envVar: "FOO_DATABASE_URL", url: "postgres://container" });
    expect(provide).toHaveBeenCalledWith("fooUrl", "postgres://container");

    await teardown();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("passes an optional image override through to startPostgres", async () => {
    m.startPostgres.mockResolvedValue({ url: "u", stop: vi.fn() });

    await pgGlobalSetup({ ...opts, image: "postgres:16-alpine" })({ provide: vi.fn() });

    expect(m.startPostgres).toHaveBeenCalledWith("postgres:16-alpine");
  });

  it("when Docker is unreachable: warns, provides undefined, skips migration, and returns a no-op teardown", async () => {
    m.startPostgres.mockRejectedValue(new Error("Cannot connect to the Docker daemon"));
    const provide = vi.fn();
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    const teardown = await pgGlobalSetup(opts)({ provide });

    expect(provide).toHaveBeenCalledWith("fooUrl", undefined); // gate downstream → suites skip
    expect(m.applyMigrations).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalled(); // a visible warning, not a silent pass
    await expect(teardown()).resolves.toBeUndefined(); // teardown is safe to call

    stderr.mockRestore();
  });

  it("when PG_TEST_HARNESS=off: starts no container, provides undefined, and returns a no-op teardown", async () => {
    vi.stubEnv("PG_TEST_HARNESS", "off");
    const provide = vi.fn();

    const teardown = await pgGlobalSetup(opts)({ provide });

    expect(m.startPostgres).not.toHaveBeenCalled();
    expect(m.applyMigrations).not.toHaveBeenCalled();
    expect(provide).toHaveBeenCalledWith("fooUrl", undefined);
    await expect(teardown()).resolves.toBeUndefined();
  });
});
