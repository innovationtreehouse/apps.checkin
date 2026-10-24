/**
 * Advisory-lock guard (F19). The monitoring relay and watchdog are intended to run at reserved
 * concurrency = 1, but that flag is invisible to the code: two overlapping invocations fail
 * fast with {@link ConcurrentRunError} instead of draining the outbox concurrently.
 */
import pg from "pg";
import { withAdvisoryLock as withLock } from "@checkin/pg-kit";

export { ConcurrentRunError } from "@checkin/pg-kit";

/** Run `fn` under the advisory lock for `key`, on its own connection to MONITORING_DATABASE_URL by default. */
export async function withAdvisoryLock<T>(
  key: string,
  fn: () => Promise<T>,
  connectionString: string | undefined = process.env.MONITORING_DATABASE_URL,
): Promise<T> {
  if (!connectionString) throw new Error("MONITORING_DATABASE_URL is not set; cannot open the advisory-lock connection.");
  return withLock(key, fn, async () => {
    const client = new pg.Client({ connectionString });
    await client.connect();
    return client;
  });
}
