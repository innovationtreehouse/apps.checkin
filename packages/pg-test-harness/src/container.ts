/**
 * Boots a throwaway Postgres in a container for the DB-gated integration tier.
 *
 * Design choices that matter (see the team blueprint):
 *   - **Pinned image.** Match the RDS engine major so tests run on the same Postgres the
 *     fleet deploys against. Override per call if a package needs a different major.
 *   - **tmpfs data dir + durability off.** The container is discarded after the run, so
 *     `fsync`/WAL durability buys nothing — turning it off keeps all the churn in RAM and
 *     off the host disk, and makes truncate-between-tests cheap.
 *   - **One container per `vitest run`.** Started in globalSetup, not per file/test; the
 *     ~1–2s cold start amortizes across the whole suite.
 */
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";

/** The Postgres image the integration tier runs against. Pin to the deployed RDS major. */
export const DEFAULT_PG_IMAGE = "public.ecr.aws/docker/library/postgres:17-alpine";

export interface StartedPg {
  /** `postgresql://user:pass@host:port/db` for both `migrate deploy` and the test client. */
  url: string;
  /** Stop + remove the container. Call from the globalSetup teardown. */
  stop: () => Promise<void>;
}

/**
 * Start an ephemeral Postgres. Throws if Docker is unreachable — the caller decides whether
 * that is fatal (CI) or a skip (local without Docker).
 */
export async function startPostgres(image: string = DEFAULT_PG_IMAGE): Promise<StartedPg> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(image)
    // Data dir in RAM — nothing here needs to survive the process.
    .withTmpFs({ "/var/lib/postgresql/data": "rw" })
    // Durability is pointless for a disposable DB; off = far less churn, faster writes.
    .withCommand([
      "postgres",
      "-c",
      "fsync=off",
      "-c",
      "synchronous_commit=off",
      "-c",
      "full_page_writes=off",
    ])
    .start();

  return {
    url: container.getConnectionUri(),
    stop: () => container.stop().then(() => undefined),
  };
}
