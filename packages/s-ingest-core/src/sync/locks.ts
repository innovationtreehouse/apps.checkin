/**
 * Advisory-lock guard for the ingestion fleet (F19). The fleet is intended to run at Lambda
 * reserved concurrency = 1, but raw-log dedup, watermark advance and the bulk state machine
 * must not rest on that deployment flag alone: two overlapping runs for one key fail fast
 * with {@link ConcurrentRunError} instead of corrupting state.
 */
import { withAdvisoryLock as withLock } from "@checkin/pg-kit";

export { ConcurrentRunError } from "@checkin/pg-kit";

/** Run `fn` under the advisory lock for `key`, on a connection to SHOPIFY_READ_DATABASE_URL by default. */
export function withAdvisoryLock<T>(
  key: string,
  fn: () => Promise<T>,
  connectionString: string | undefined = process.env.SHOPIFY_READ_DATABASE_URL,
): Promise<T> {
  return withLock(key, fn, connectionString, "SHOPIFY_READ_DATABASE_URL");
}
