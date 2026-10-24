/**
 * Advisory-lock guard for the ingestion fleet (F19). The fleet is intended to run at Lambda
 * reserved concurrency = 1, but raw-log dedup, watermark advance and the bulk state machine
 * must not rest on that deployment flag alone: two overlapping runs for one key fail fast
 * with {@link ConcurrentRunError} instead of corrupting state.
 */
import pg from "pg";
import { withAdvisoryLock as withLock } from "@checkin/pg-kit";

export { ConcurrentRunError } from "@checkin/pg-kit";

/** Run `fn` under the advisory lock for `key`, on its own connection to SHOPIFY_READ_DATABASE_URL by default. */
export async function withAdvisoryLock<T>(
  key: string,
  fn: () => Promise<T>,
  connectionString: string | undefined = process.env.SHOPIFY_READ_DATABASE_URL,
): Promise<T> {
  if (!connectionString) throw new Error("SHOPIFY_READ_DATABASE_URL is not set; cannot open the advisory-lock connection.");
  return withLock(key, fn, async () => {
    const client = new pg.Client({ connectionString });
    await client.connect();
    return client;
  });
}
