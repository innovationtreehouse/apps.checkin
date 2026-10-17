/**
 * describeDb must never let a missing database read as a green run in CI: it runs the suite
 * when the URL is set, skips loudly locally, and throws under CI / REQUIRE_DB=1.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { dbGateMode, describeDb } from "./describeDb.js";

const VAR = "PG_HARNESS_GATE_TEST_URL";

describe("dbGateMode", () => {
  it("runs when the env var is set, even under CI", () => {
    expect(dbGateMode(VAR, { [VAR]: "postgres://x", CI: "true", REQUIRE_DB: "1" })).toBe("run");
  });

  it("skips locally when the env var is unset", () => {
    expect(dbGateMode(VAR, {})).toBe("skip");
  });

  it("fails under CI or REQUIRE_DB=1 when the env var is unset", () => {
    expect(dbGateMode(VAR, { CI: "true" })).toBe("fail");
    expect(dbGateMode(VAR, { REQUIRE_DB: "1" })).toBe("fail");
  });

  it("REQUIRE_DB=0 turns the CI requirement off", () => {
    expect(dbGateMode(VAR, { CI: "true", REQUIRE_DB: "0" })).toBe("skip");
  });
});

describe("describeDb", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("throws naming the env var and the suite when the DB is required", () => {
    vi.stubEnv(VAR, "");
    vi.stubEnv("REQUIRE_DB", "1");
    expect(() => describeDb(VAR)("orders projection", () => {})).toThrow(
      `${VAR} is required to run integration suite "orders projection"`,
    );
  });

});

// Declaring a suite is only allowed at collection time, so the skip path runs here, not in an `it`.
describe("describeDb skip path", () => {
  vi.stubEnv(VAR, "");
  vi.stubEnv("REQUIRE_DB", "0");
  const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  describeDb(VAR)("orders projection", () => {
    it("is skipped", () => {
      throw new Error("a skipped suite must not run");
    });
  });
  const warnings = write.mock.calls.map(([chunk]) => String(chunk));
  write.mockRestore();
  vi.unstubAllEnvs();

  it("writes a warning naming the skipped suite when the DB is absent locally", () => {
    expect(warnings).toContainEqual(expect.stringContaining(`skipping integration suite "orders projection"`));
  });
});

describe("describeDb run path", () => {
  vi.stubEnv(VAR, "postgres://x");
  let ran = false;
  describeDb(VAR)("with a database", () => {
    it("runs", () => {
      ran = true;
    });
  });
  vi.unstubAllEnvs();

  it("declared the suite as a normal describe", () => {
    expect(ran).toBe(true);
  });
});
