/**
 * Admin API token acquisition for the deployed Lambda.
 *
 * Precedence:
 *   - `SHOPIFY_ADMIN_TOKEN` set (local dev / legacy custom apps) → used verbatim,
 *     forever. No minting, no cache, no expiry tracking.
 *   - Otherwise, mint a short-lived (~24h) token via the client-credentials grant from
 *     `SHOPIFY_CLIENT_ID` + `SHOPIFY_CLIENT_SECRET` (see README "Getting the token" /
 *     FUTUREWORK.md §5), cached at module scope so a warm Lambda container reuses it
 *     across invocations instead of re-minting every run.
 *
 * Shopify's client-credentials grant returns no refresh token; renewing is just re-running
 * the client_id/client_secret exchange. So this is deliberately in-memory only, no DB table.
 *
 * Mirrors checkin-app/src/lib/shopify/client.ts's getAccessToken shape (cache + 5-min-early
 * refresh), but standalone — this package imports nothing from checkin-app.
 */
import type { ShopifyConfig } from "@checkin/s-ingest-core";

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // fallback when the response has no expires_in
const REFRESH_BUFFER_MS = 5 * 60 * 1000;
const MINT_TIMEOUT_MS = 20_000; // same budget as client.ts's per-attempt REQUEST_TIMEOUT_MS

let cachedToken: string | null = null;
let tokenExpiresAt = 0;

/** @internal test-only — resets the module-scope cache between test cases. */
export function resetShopifyTokenCache(): void {
  cachedToken = null;
  tokenExpiresAt = 0;
}

/** Drop the cached token so the next getShopifyToken call re-mints. Used after a 401. */
export function invalidateShopifyToken(): void {
  cachedToken = null;
  tokenExpiresAt = 0;
}

/**
 * Resolves the Admin API token to send on the next request.
 * - `cfg.adminToken` set → returned unchanged (static precedence).
 * - Else mints via client-credentials, caching until ~5 minutes before its ~24h expiry.
 */
export async function getShopifyToken(cfg: ShopifyConfig): Promise<string> {
  if (cfg.adminToken) return cfg.adminToken;

  if (!cfg.clientId || !cfg.clientSecret) {
    throw new Error("No Shopify credentials configured: set SHOPIFY_ADMIN_TOKEN, or SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET.");
  }

  if (cachedToken && Date.now() < tokenExpiresAt - REFRESH_BUFFER_MS) {
    return cachedToken;
  }

  // ponytail: no backoff/retry on the mint call itself (unlike the GraphQL request loop) —
  // a transient blip here fails the whole invocation and the next scheduled run picks it
  // back up. Add retry if token-endpoint flakiness shows up in practice.
  const res = await fetch(`https://${cfg.shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
    }).toString(),
    // A hung exchange would otherwise run to the ECS task timeout.
    signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`Shopify token exchange failed: HTTP ${res.status} ${(await res.text()).slice(0, 500)}`);
  }

  const body = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) {
    throw new Error("Shopify token exchange response had no access_token");
  }

  cachedToken = body.access_token;
  // Trust the response's expires_in when present; ~24h is only the documented default.
  tokenExpiresAt = Date.now() + (typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in * 1000 : TOKEN_TTL_MS);
  return cachedToken;
}
