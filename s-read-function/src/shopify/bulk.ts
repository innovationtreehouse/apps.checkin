/**
 * Shopify Bulk Operation lifecycle for the orders backfill.
 *
 * Bulk operations run asynchronously on Shopify's side: start one, then poll it by id with
 * `bulkOperation(id:)` on later invocations until COMPLETED, then download the JSONL result.
 * Starting a second export while one runs is refused by Shopify as a `bulkOperationRunQuery`
 * userError, which startOrdersBackfill throws. The reassembly of that JSONL into nested order nodes — and its durable, verbatim
 * pre-transform capture — lives in @checkin/s-ingest-core so the same code path can also
 * drive recovery (reingestBulkExports). `reassembleOrders` / `parseBulkJsonl` are re-exported
 * here for callers and tests that import them from this module.
 *
 * NOTE: `shopifyPaymentsAccount` is a singleton, not a top-level connection, so
 * payouts/balance-transactions are NOT bulk-exportable as a top-level query — the
 * backfill pulls those via the paginated cursor fetchers instead (see sync/backfill).
 */
import { logger } from "@checkin/s-ingest-core";
import type { ShopifyClient } from "./client.js";
import { jitteredBackoffMs } from "./client.js";
import {
  BULK_OPERATION_RUN_MUTATION,
  BULK_OPERATION_QUERY,
  buildOrdersBulkQuery,
} from "./queries.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Hard client-side deadline for the JSONL download; a hung GCS read must not run to the Lambda timeout. */
export const BULK_DOWNLOAD_TIMEOUT_MS = 60_000;
/** Bounded retries for a transient download failure (matches the GraphQL client's spirit). */
export const BULK_DOWNLOAD_MAX_ATTEMPTS = 4;

/**
 * Hosts a Shopify bulk-operation result URL is allowed to point at. Shopify serves the
 * JSONL as a Google Cloud Storage signed URL on storage.googleapis.com. The URL comes
 * from the GraphQL `bulkOperation.url` response, so it is attacker-influenced if
 * that response is ever spoofed/compromised — restricting the host stops the download
 * from being turned into SSRF against internal endpoints or the cloud metadata service.
 */
export const ALLOWED_BULK_HOSTS = ["storage.googleapis.com"];

/** Parse + validate a bulk result URL: https only, host on the allowlist. Throws otherwise. */
export function assertAllowedBulkUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("bulk result URL rejected: not a valid URL");
  }
  if (parsed.protocol !== "https:") {
    logger.warn("rejected bulk download URL (scheme)", { protocol: parsed.protocol, host: parsed.hostname });
    throw new Error(`bulk result URL rejected: scheme ${parsed.protocol} (https required)`);
  }
  const host = parsed.hostname.toLowerCase();
  const allowed = ALLOWED_BULK_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  if (!allowed) {
    logger.warn("rejected bulk download URL (host)", { host });
    throw new Error(`bulk result URL rejected: host ${host} not on allowlist`);
  }
  return parsed;
}

export { reassembleOrders, parseBulkJsonl } from "@checkin/s-ingest-core";

export interface BulkOperation {
  id: string;
  status: string; // CREATED | RUNNING | COMPLETED | FAILED | CANCELED | ...
  errorCode?: string | null;
  objectCount?: string | null;
  url?: string | null;
  partialDataUrl?: string | null;
}

export async function startOrdersBackfill(client: ShopifyClient, cutoverIso: string): Promise<BulkOperation> {
  const data = await client.request<{
    bulkOperationRunQuery: { bulkOperation: BulkOperation | null; userErrors: { field: string[]; message: string }[] };
  }>(BULK_OPERATION_RUN_MUTATION, { query: buildOrdersBulkQuery(cutoverIso) });

  const { bulkOperation, userErrors } = data.bulkOperationRunQuery;
  if (userErrors.length > 0) {
    throw new Error(`bulkOperationRunQuery failed: ${userErrors.map((e) => e.message).join("; ")}`);
  }
  if (!bulkOperation) throw new Error("bulkOperationRunQuery returned no operation");
  return bulkOperation;
}

/** Null when Shopify no longer knows the id. */
export async function getBulkOperation(client: ShopifyClient, id: string): Promise<BulkOperation | null> {
  const data = await client.request<{ bulkOperation: BulkOperation | null }>(BULK_OPERATION_QUERY, { id });
  return data.bulkOperation;
}

/**
 * Download the raw JSONL result verbatim. Reassembly + durable capture happen in
 * ingestBulkOrders.
 *
 * Hardened with a hard per-attempt deadline (AbortSignal) so a hung GCS connection fails
 * fast instead of running the whole invocation into the Lambda timeout (which would leave a
 * dangling RUNNING sync_run), plus bounded backoff retries on a transient failure (timeout,
 * network, 429/5xx). A non-retryable status (e.g. 403 on an expired signed URL) throws at
 * once. `backoffMs` is injectable so tests don't sleep.
 */
export async function downloadBulkJsonl(
  url: string,
  opts: { timeoutMs?: number; maxAttempts?: number; backoffMs?: (attempt: number) => number } = {},
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? BULK_DOWNLOAD_TIMEOUT_MS;
  const maxAttempts = opts.maxAttempts ?? BULK_DOWNLOAD_MAX_ATTEMPTS;
  const backoffMs = opts.backoffMs ?? jitteredBackoffMs;

  // Validate before any fetch: SSRF guard on the attacker-influenceable GraphQL-supplied URL.
  const safeUrl = assertAllowedBulkUrl(url);

  let attempt = 0;

  while (true) {
    attempt++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // redirect: "manual" so a 3xx can't bounce us off the allowlist to an internal host.
      const res = await fetch(safeUrl, { signal: controller.signal, redirect: "manual" });
      if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
        logger.warn("bulk download blocked redirect", { status: res.status });
        // Non-retryable (recognized prefix): a redirect off the signed URL is not transient.
        throw new Error(`Failed to download bulk result: HTTP ${res.status} (redirect blocked)`);
      }
      if (!res.ok) {
        const transient = res.status === 429 || res.status >= 500;
        if (transient && attempt < maxAttempts) {
          logger.warn("bulk download retry (transport)", { attempt, status: res.status });
          await sleep(backoffMs(attempt));
          continue;
        }
        throw new Error(`Failed to download bulk result: HTTP ${res.status}`);
      }
      return await res.text();
    } catch (err) {
      // A decided non-retryable HTTP status was already thrown above — let it propagate.
      if (err instanceof Error && err.message.startsWith("Failed to download bulk result: HTTP")) throw err;
      // Otherwise (abort/timeout, network error): retry until the attempt budget is spent.
      if (attempt >= maxAttempts) throw err;
      logger.warn("bulk download retry (timeout/network)", { attempt, err: err instanceof Error ? err.message : String(err) });
      await sleep(backoffMs(attempt));
    } finally {
      clearTimeout(timer);
    }
  }
}
