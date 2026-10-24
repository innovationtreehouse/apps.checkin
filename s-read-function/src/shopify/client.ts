/**
 * Thin Shopify Admin GraphQL client with Shopify's canonical rate-limit handling.
 *
 * - GraphQL THROTTLED errors → wait per Shopify's formula using the cost the API
 *   returns: (requestedQueryCost - currentlyAvailable) / restoreRate seconds.
 *   See https://shopify.dev/docs/api/usage/rate-limits — Shopify hands you the math,
 *   so we don't guess with exponential backoff here.
 * - Transport errors (429 / 5xx / network) → capped exponential backoff with full
 *   jitter, honoring a `Retry-After` header when present (clamped to the cap).
 *
 * Uses the global `fetch` (Node 18+); no SDK dependency, so the bundle stays small.
 */
import { type ShopifyConfig, logger } from "@checkin/s-ingest-core";
import { getShopifyToken, invalidateShopifyToken } from "./token.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const MAX_ATTEMPTS = 8;
export const BASE_DELAY_MS = 500;
export const MAX_DELAY_MS = 30_000;
/**
 * Hard per-request deadline (mirrors bulk.ts's BULK_DOWNLOAD_TIMEOUT_MS). A hung TCP
 * connection (established, no response) must trip the abort and retry, not run the whole
 * invocation into the Lambda timeout (which leaves a dangling RUNNING sync_run).
 */
export const REQUEST_TIMEOUT_MS = 30_000;
/** Shopify's minimal fallback wait when no cost info is available. */
export const MIN_THROTTLE_WAIT_MS = 1_000;
/** Small cushion added to the computed throttle wait to avoid retrying a hair early. */
export const THROTTLE_BUFFER_MS = 250;

export interface ThrottleStatus {
  maximumAvailable: number;
  currentlyAvailable: number;
  restoreRate: number;
}
export interface QueryCost {
  requestedQueryCost?: number;
  actualQueryCost?: number;
  throttleStatus?: ThrottleStatus;
}
interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string; extensions?: { code?: string } }>;
  extensions?: { cost?: QueryCost };
}

// --- pure, unit-tested helpers ----------------------------------------------

/**
 * Shopify's recommended throttle wait: how long until the bucket holds enough
 * points for this query to run again. Floors at MIN_THROTTLE_WAIT_MS and falls
 * back to it when cost info is missing; caps at capMs.
 */
export function throttleWaitMs(cost: QueryCost | undefined, capMs: number = MAX_DELAY_MS): number {
  const status = cost?.throttleStatus;
  const requested = cost?.requestedQueryCost;
  if (!status || !status.restoreRate || status.restoreRate <= 0 || requested == null || status.currentlyAvailable == null) {
    return MIN_THROTTLE_WAIT_MS;
  }
  const deficit = Math.max(0, requested - status.currentlyAvailable);
  const ms = Math.ceil((deficit / status.restoreRate) * 1000) + THROTTLE_BUFFER_MS;
  return Math.min(capMs, Math.max(MIN_THROTTLE_WAIT_MS, ms));
}

/** Deterministic exponential ceiling (pre-jitter), capped at capMs. */
export function backoffCeilingMs(attempt: number, baseMs: number = BASE_DELAY_MS, capMs: number = MAX_DELAY_MS): number {
  return Math.min(capMs, baseMs * 2 ** (attempt - 1));
}

/**
 * Full-jitter exponential backoff: a random delay in [0, ceiling]. `rand` is
 * injectable for deterministic tests; defaults to Math.random.
 */
export function jitteredBackoffMs(
  attempt: number,
  rand: () => number = Math.random,
  baseMs: number = BASE_DELAY_MS,
  capMs: number = MAX_DELAY_MS,
): number {
  return Math.floor(rand() * backoffCeilingMs(attempt, baseMs, capMs));
}

/** Parse a `Retry-After` header (seconds) into ms, clamped to capMs. null if absent/invalid. */
export function retryAfterMs(headerValue: string | null | undefined, capMs: number = MAX_DELAY_MS): number | null {
  if (!headerValue) return null;
  const secs = Number(headerValue);
  if (!Number.isFinite(secs) || secs < 0) return null;
  return Math.min(capMs, Math.ceil(secs * 1000));
}

// --- client ------------------------------------------------------------------

export interface ShopifyClient {
  request<T>(query: string, variables?: Record<string, unknown>): Promise<T>;
  readonly endpoint: string;
}

export function createShopifyClient(cfg: ShopifyConfig): ShopifyClient {
  async function request<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    let attempt = 0;
    // A warm Lambda can hold a token that's since expired/been rotated; allow exactly one
    // invalidate-and-remint retry per request, not a loop (see token.ts / #237).
    let authRetried = false;

    while (true) {
      attempt++;
      const token = await getShopifyToken(cfg);
      let res: Response;
      // Per-attempt deadline INSIDE the loop so a hang aborts and retries (not a single
      // failure that runs to the Lambda timeout). Timer cleared in finally so it can't leak.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        res = await fetch(cfg.endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": token,
          },
          body: JSON.stringify({ query, variables }),
          signal: controller.signal,
        });
      } catch (err) {
        const timedOut = controller.signal.aborted;
        if (attempt >= MAX_ATTEMPTS) {
          if (timedOut) throw new Error(`Shopify request timed out after ${REQUEST_TIMEOUT_MS}ms (${attempt} attempts)`);
          throw err;
        }
        const waitMs = jitteredBackoffMs(attempt);
        logger.warn("shopify retry (network error)", { attempt, waitMs, timedOut });
        await sleep(waitMs);
        continue;
      } finally {
        clearTimeout(timer);
      }

      // Stale cached token → invalidate and re-mint once, then retry immediately (no backoff;
      // this isn't a rate limit). If it 401s again, fall through to the generic !res.ok throw.
      if (res.status === 401 && !authRetried) {
        authRetried = true;
        invalidateShopifyToken();
        logger.warn("shopify 401; invalidating cached token and retrying once", { attempt });
        continue;
      }

      // Transport-level throttle / server errors → jittered backoff (honor Retry-After).
      if (res.status === 429 || res.status >= 500) {
        if (attempt >= MAX_ATTEMPTS) {
          throw new Error(`Shopify request failed after ${attempt} attempts: HTTP ${res.status}`);
        }
        const waitMs = retryAfterMs(res.headers.get("Retry-After")) ?? jitteredBackoffMs(attempt);
        logger.warn("shopify retry (transport)", { attempt, status: res.status, waitMs });
        await sleep(waitMs);
        continue;
      }
      if (!res.ok) {
        throw new Error(`Shopify request failed: HTTP ${res.status} ${await safeText(res)}`);
      }

      const body = (await res.json()) as GraphQLResponse<T>;

      // GraphQL cost-throttling → wait per Shopify's formula, not exponential.
      const throttled = body.errors?.some((e) => e.extensions?.code === "THROTTLED");
      if (throttled) {
        if (attempt >= MAX_ATTEMPTS) {
          throw new Error(`Shopify throttled after ${attempt} attempts`);
        }
        const waitMs = throttleWaitMs(body.extensions?.cost);
        logger.warn("shopify throttled; waiting per cost", { attempt, waitMs, cost: body.extensions?.cost });
        await sleep(waitMs);
        continue;
      }

      if (body.errors && body.errors.length > 0) {
        throw new Error(`Shopify GraphQL error: ${body.errors.map((e) => e.message).join("; ")}`);
      }
      if (!body.data) {
        throw new Error("Shopify GraphQL response had no data");
      }
      return body.data;
    }
  }

  return { request, endpoint: cfg.endpoint };
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "";
  }
}
