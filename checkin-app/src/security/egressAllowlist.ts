/**
 * Where code may reach a third party, read by scripts/check-route-coverage.ts.
 *
 * This file sits in the security boundary set, so widening an allowlist or
 * loosening a pattern ships in its own PR. Nothing in the app imports it.
 */

/** App files (relative to checkin-app/) allowed to fetch a THIRD_PARTY_HOST_RE host directly. */
export const APP_THIRD_PARTY_FETCH_FILES: readonly string[] = [
    'src/lib/shopify/client.ts',
    'src/lib/shopify/products.ts',
    'src/lib/shopify/stock.ts',
    'src/lib/shopify/discounts.ts',
    'src/lib/email.ts',
];

/**
 * Package egress files (relative to the monorepo root) and the outbound surfaces
 * each serves. Every surface must be a defineOutbound entry in the registry.
 * These callers do not go through outboundCall, so their payloads are not
 * stripped by tier: the surface's tiers describe the code, not enforce it.
 */
export const PACKAGE_EGRESS_FILES: ReadonlyMap<string, readonly string[]> = new Map([
    ['packages/quickbooks/src/client.ts', ['quickbooks.query', 'quickbooks.create', 'quickbooks.vendor']],
    ['packages/quickbooks/src/oauth.ts', ['quickbooks.oauth']],
    ['packages/receipt/src/lib/ocr.ts', ['anthropic.receipt-ocr']],
    ['packages/receipt/src/lib/gmail.ts', ['gmail.read']],
    // Builds the endpoint; s-read-function makes the call.
    ['packages/s-ingest-core/src/config.ts', ['shopify.admin-read']],
    ['s-read-function/src/shopify/token.ts', ['shopify.oauth']],
]);

export const THIRD_PARTY_HOST_RE =
    /(shopify\.com|myshopify\.com|resend\.com|SHOPIFY_STORE_DOMAIN|intuit\.com|api\.anthropic\.com|gmail\.googleapis\.com)/;
/** An absolute URL with a host (literal, `${…}` or `[ipv6]`), except loopback. A bare
 *  scheme prefix (`"https://" + host`) is not a fixed destination and does not match. */
export const NON_LOOPBACK_URL_RE = /\bhttps?:\/\/(?!(?:localhost|127\.0\.0\.1|\[::1\])(?![\w.-]))[\w$[]/;
/** An API SDK hides its host (the Anthropic SDK defaults to api.anthropic.com, resend to
 *  api.resend.com). @aws-sdk/* is absent: it reaches only AWS, the platform the code runs on. */
export const THIRD_PARTY_SDK_RE = /['"](@anthropic-ai\/sdk|resend|googleapis|@googleapis\/gmail)['"]/;
