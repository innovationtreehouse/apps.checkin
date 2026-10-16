/**
 * The integration-tier gate every harness consumer wraps its DB suites in.
 *
 *   - envVar set                    → the suite runs.
 *   - envVar unset                  → the suite is skipped, with a stderr line naming it.
 *   - envVar unset + DB required    → throws at collection, so the run cannot go green.
 *
 * The DB is required under `CI` and with `REQUIRE_DB=1`; `REQUIRE_DB=0` turns that off.
 * The env var is read when the suite is declared, after `applyHarnessEnv` has published
 * the container URL.
 */
import { describe } from "vitest";

export type DbGateMode = "run" | "skip" | "fail";

export function dbGateMode(envVar: string, env: NodeJS.ProcessEnv = process.env): DbGateMode {
  if (env[envVar]) return "run";
  if (env.REQUIRE_DB === "0") return "skip";
  return env.REQUIRE_DB === "1" || env.CI ? "fail" : "skip";
}

/** Build the `describe` for suites that need `envVar`. */
export function describeDb(envVar: string) {
  return function describeWithDb(name: string, fn: () => void): void {
    const mode = dbGateMode(envVar);
    if (mode === "fail") {
      throw new Error(
        `${envVar} is required to run integration suite "${name}" (CI / REQUIRE_DB=1) but it is not set.`,
      );
    }
    if (mode === "skip") {
      // process.stderr, not console.warn: vitest swallows console output during collection.
      process.stderr.write(
        `\x1b[33m⚠  ${envVar} is not set — skipping integration suite "${name}" (REQUIRE_DB=1 to enforce)\x1b[0m\n`,
      );
      describe.skip(name, fn);
      return;
    }
    describe(name, fn);
  };
}
