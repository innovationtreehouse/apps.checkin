/**
 * Hard dev-store-only guard for the Shopify LIVE test suite + janitor.
 *
 * These tests create and delete real products/price rules over the Admin API,
 * so pointing them at the production store must be impossible by construction,
 * not by convention. Three independent checks, all of which must pass:
 *
 *   1. DENYLIST — the production store domain (public, checked into
 *      infra modules/checkin/overview.tf) is refused outright, even if every
 *      other variable says to proceed.
 *   2. DOUBLE KEY — SHOPIFY_STORE_DOMAIN must EQUAL
 *      SHOPIFY_LIVE_ALLOWED_DOMAIN. The workflow wires the store domain; a
 *      human provisions the allowed-domain repo variable. Retargeting the
 *      suite therefore requires two deliberate edits in two places.
 *   3. SHAPE — the domain must be a *.myshopify.com storefront.
 *
 * Pure module (no jest, no app imports) so the normal unit suite can cover it
 * — the guard itself is CI-tested even though the live suite never runs in CI.
 */

/** The PRODUCTION store. Never a valid live-test target under any configuration. */
export const PROD_STORE_DOMAIN = "9jhydb-ka.myshopify.com";

/** Title prefix for every resource the live suite creates; the janitor sweeps it. */
export const CITEST_PREFIX = "citest-";

/**
 * Reserved programId range for live-test discount codes: mintMemberDiscountCode
 * titles rules `PRG<programId>-H<householdId>-XXXX`, so this range makes them janitor-recognizable.
 */
export const CITEST_PROGRAM_ID_BASE = 999_999_900;

export function assertLiveTestStore(env: NodeJS.ProcessEnv = process.env): string {
    const domain = env.SHOPIFY_STORE_DOMAIN;
    const allowed = env.SHOPIFY_LIVE_ALLOWED_DOMAIN;

    if (!domain || !env.SHOPIFY_CLIENT_ID || !env.SHOPIFY_CLIENT_SECRET) {
        throw new Error(
            "shopify-live: missing SHOPIFY_STORE_DOMAIN / SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET — " +
            "these tests only run where dev-store credentials are provisioned (see .github/workflows/shopify-live.yml).",
        );
    }
    if (domain === PROD_STORE_DOMAIN) {
        throw new Error(
            `shopify-live: REFUSING to run against the production store (${PROD_STORE_DOMAIN}). ` +
            "This suite creates and deletes real catalog objects.",
        );
    }
    if (!allowed) {
        throw new Error(
            "shopify-live: SHOPIFY_LIVE_ALLOWED_DOMAIN is not set. Set it to the dev store domain " +
            "(second key of the two-person rule) — never to the production domain.",
        );
    }
    if (allowed === PROD_STORE_DOMAIN) {
        throw new Error("shopify-live: SHOPIFY_LIVE_ALLOWED_DOMAIN must never be the production store.");
    }
    if (domain !== allowed) {
        throw new Error(
            `shopify-live: SHOPIFY_STORE_DOMAIN (${domain}) != SHOPIFY_LIVE_ALLOWED_DOMAIN (${allowed}) — refusing.`,
        );
    }
    if (!domain.endsWith(".myshopify.com")) {
        throw new Error(`shopify-live: ${domain} is not a *.myshopify.com storefront — refusing.`);
    }
    return domain;
}
