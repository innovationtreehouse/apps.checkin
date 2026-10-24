/**
 * The reusable vitest globalSetup for any package with a Postgres integration tier.
 *
 * Lifecycle (once per `vitest run`):
 *   1. start an ephemeral Postgres container,
 *   2. `prisma migrate deploy` the package's committed migrations into it,
 *   3. `provide(provideKey, url)` so a worker-side setup file can publish it to env,
 *   4. teardown stops the container.
 *
 * If Docker is unreachable, this does NOT throw: it warns and provides `undefined`, and the
 * `describeDb` gate decides — skip locally, fail under CI / REQUIRE_DB=1.
 * `PG_TEST_HARNESS=off` takes the same path without trying Docker, for light local runs.
 *
 * Each consuming package adds a 4-line `test/globalSetup.ts` that calls this with its own
 * `migrateCwd` / `envVar` / `provideKey`. That is the entire onboarding cost.
 */
import { startPostgres } from "./container.js";
import { applyMigrations } from "./migrate.js";

export interface PgHarnessOptions {
  /** Dir with the package's `prisma.config.ts` + migrations. For consumers of a shared
   *  schema (e.g. s-replay), point this at the schema-owning package (s-ingest-core). */
  migrateCwd: string;
  /** Domain URL var the schema's `prisma.config.ts` reads. */
  envVar: string;
  /** vitest provide/inject key the matching `setupEnv.ts` reads. */
  provideKey: string;
  /** Override the pinned Postgres image if a package needs a different major. */
  image?: string;
}

export interface GlobalSetupContext {
  provide: (key: string, value: unknown) => void;
}

/** Build the globalSetup function. Default-export the result from `test/globalSetup.ts`. */
export function pgGlobalSetup(opts: PgHarnessOptions) {
  return async function setup({ provide }: GlobalSetupContext): Promise<() => Promise<void>> {
    if (process.env.PG_TEST_HARNESS === "off") {
      provide(opts.provideKey, undefined);
      return async () => {};
    }

    let started;
    try {
      started = await startPostgres(opts.image);
    } catch (err) {
      process.stderr.write(
        `\n[33m⚠  pg-test-harness: could not start a Postgres container — is Docker running?\n` +
          `   Integration suites gated on ${opts.envVar} will be skipped.\n` +
          `   ${String(err)}[0m\n`,
      );
      provide(opts.provideKey, undefined);
      return async () => {};
    }

    applyMigrations({ migrateCwd: opts.migrateCwd, envVar: opts.envVar, url: started.url });
    provide(opts.provideKey, started.url);

    return async () => {
      await started.stop();
    };
  };
}
