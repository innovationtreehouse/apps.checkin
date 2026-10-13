// Shopify API integration using Client Credentials Grant (post-Jan 2026)
// Tokens expire after 24 hours and are cached in-memory.

import crypto from "crypto";
import prisma from "@/lib/prisma";
import { sendEmail } from "@/lib/email";
import { escapeHtml } from "@/lib/email-templates/base";
import { logIntegrationError } from "@/lib/logger";
import { config } from "@/lib/config";
import { LIVE_PERSON } from "@/lib/person/filters";
import { programMemberCodePrefix } from "@/lib/programs/memberDiscountCode";

let cachedToken: string | null = null;
let tokenExpiresAt: number = 0;

/**
 * Hard per-request deadline for every Shopify call. Without it a hung TCP connection
 * (established, no response) blocks the request worker until the platform timeout; during
 * a Shopify outage that exhausts workers, and the serial variant-creation chain below
 * stalls entirely on one hang. ~20s suits these interactive calls.
 */
const SHOPIFY_FETCH_TIMEOUT_MS = 20_000;

/** Admin API version for every REST call here and in scripts/register-shopify-webhook.ts — bump it in one place. */
export const SHOPIFY_API_VERSION = "2026-01";

/** fetch with a hard timeout that surfaces as a clear error instead of hanging. */
export async function shopifyFetch(input: string, init: RequestInit, label: string): Promise<Response> {
  try {
    return await fetch(input, { ...init, signal: AbortSignal.timeout(SHOPIFY_FETCH_TIMEOUT_MS) });
  } catch (err) {
    if (err instanceof DOMException && (err.name === "TimeoutError" || err.name === "AbortError")) {
      throw new Error(`${label} timed out after ${SHOPIFY_FETCH_TIMEOUT_MS}ms`);
    }
    throw err;
  }
}

/** @internal - Exported only for test isolation */
export function resetTokenCache() {
  cachedToken = null;
  tokenExpiresAt = 0;
}

/**
 * Fetches a fresh Admin API access token using the client credentials grant.
 * Caches the token and refreshes ~5 minutes before expiry.
 */
export async function getAccessToken(): Promise<string | null> {
  const storeDomain = config.shopifyStoreDomain();
  const clientId = config.shopifyClientId();
  const clientSecret = config.shopifyClientSecret();

  if (!storeDomain || !clientId || !clientSecret) {
    console.warn("Shopify integration is disabled: Missing SHOPIFY_STORE_DOMAIN, SHOPIFY_CLIENT_ID, or SHOPIFY_CLIENT_SECRET in .env");
    return null;
  }

  // Return cached token if still valid (with 5-minute buffer)
  if (cachedToken && Date.now() < tokenExpiresAt - 5 * 60 * 1000) {
    return cachedToken;
  }

  try {
    const res = await shopifyFetch(`https://${storeDomain}/admin/oauth/access_token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
    }, "Shopify token exchange");

    if (!res.ok) {
      const errorText = await res.text();
      console.error(`Failed to obtain Shopify access token: ${res.status} ${errorText}`);
      cachedToken = null;
      return null;
    }

    const data = await res.json();
    cachedToken = data.access_token;

    // Tokens last 24 hours; cache for 23 hours 55 minutes
    tokenExpiresAt = Date.now() + 23 * 60 * 60 * 1000 + 55 * 60 * 1000;

    console.log("[SHOPIFY] Successfully obtained new access token");
    return cachedToken;
  } catch (error) {
    console.error("Failed to fetch Shopify access token:", error);
    cachedToken = null;
    return null;
  }
}

/** Thrown by fetchStorefrontProductVariants; status maps straight onto the API response. */
export class ProductUrlError extends Error {
    constructor(message: string, public readonly status: number) {
        super(message);
        this.name = "ProductUrlError";
    }
}

export interface StorefrontVariant {
    id: string;
    title: string;
    /** The public product JSON reports prices in cents; null when the shape is unexpected. */
    priceCents: number | null;
}

/**
 * Resolve the variants of a membership product from its storefront URL via
 * Shopify's public product JSON (`https://<store>/products/<handle>.js`).
 * Backs the "Extract variant from URL" action in membership settings: for a
 * single-variant product the Shopify admin UI hides the lone "Default Title"
 * variant entirely, so the product ID is the only number an admin can see —
 * and pasting THAT into the variant-ID field 410s the cart permalink checkout
 * (lib/membership/payment.ts builds https://<store>/cart/<variantId>:1).
 *
 * SSRF pinning — this is a server-side fetch of an admin-supplied URL, so the
 * URL is pinned hard before any request goes out: https only, host must
 * EXACTLY equal the configured SHOPIFY_STORE_DOMAIN, path must match
 * /products/<handle> after normalization (query, hash, and trailing slash
 * stripped), and redirects are refused rather than followed. Everything else
 * is a 400 before fetch.
 *
 * Shopify bot-throttles the .js endpoint for non-browser callers (429s
 * observed from server IPs), so the request carries a browser User-Agent and
 * retries twice with a short backoff; a still-throttled request surfaces as
 * "try again in a minute", not a generic failure. The Admin API would be the
 * throttle-proof alternative if this keeps biting.
 */
export async function fetchStorefrontProductVariants(productUrl: string): Promise<StorefrontVariant[]> {
    const storeDomain = config.shopifyStoreDomain();
    if (!storeDomain) throw new ProductUrlError("SHOPIFY_STORE_DOMAIN is not configured on this instance, so the URL cannot be verified.", 400);

    let parsed: URL;
    try {
        parsed = new URL(productUrl.trim());
    } catch {
        throw new ProductUrlError("That is not a valid URL.", 400);
    }
    if (parsed.protocol !== "https:") throw new ProductUrlError("The product URL must start with https://.", 400);
    // URL lowercases the hostname and drops a default :443, so an exact host
    // comparison also rejects any explicit non-default port.
    if (parsed.host !== storeDomain.toLowerCase()) {
        throw new ProductUrlError(`The product URL must be on the store domain ${storeDomain}.`, 400);
    }
    const productPath = parsed.pathname.replace(/\/+$/, "");
    if (!/^\/products\/[a-z0-9-]+$/.test(productPath)) {
        throw new ProductUrlError(`The URL must be a product page: https://${storeDomain}/products/<product-handle>.`, 400);
    }

    let res: Response | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
        try {
            res = await fetch(`https://${storeDomain}${productPath}.js`, {
                headers: {
                    // Browser User-Agent: see the throttling note in the doc comment.
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
                    Accept: "application/json",
                },
                redirect: "error", // any redirect could leave the pinned host — refuse it
                signal: AbortSignal.timeout(10_000),
            });
        } catch (err) {
            if (err instanceof DOMException && (err.name === "TimeoutError" || err.name === "AbortError")) {
                throw new ProductUrlError("Shopify did not answer within 10 seconds — try again.", 504);
            }
            // undici surfaces a refused redirect (and any network failure) as a TypeError.
            throw new ProductUrlError("Could not fetch the product from Shopify — the request failed or was redirected.", 502);
        }
        if (res.status !== 429) break;
    }
    if (!res || res.status === 429) throw new ProductUrlError("Shopify throttled the request — try again in a minute.", 429);
    if (res.status === 404) throw new ProductUrlError("Shopify has no product at that URL — check the link.", 404);
    if (!res.ok) throw new ProductUrlError(`Shopify returned ${res.status} for the product URL — check the link and try again.`, 502);

    let product: { variants?: Array<{ id?: number | string; title?: string; price?: unknown }> };
    try {
        product = await res.json();
    } catch {
        throw new ProductUrlError("Shopify's response was not product JSON — check that the URL is the product page.", 502);
    }
    if (!Array.isArray(product?.variants)) {
        throw new ProductUrlError("Shopify's response has no variant list — check that the URL is the product page.", 502);
    }
    return product.variants
        .filter((v) => v?.id !== undefined && v?.id !== null)
        .map((v) => ({
            id: String(v.id),
            title: v.title || "Default Title",
            priceCents: typeof v.price === "number" ? v.price : null,
        }));
}

/**
 * Shared failure path for Shopify write operations: log to IntegrationErrorLog
 * (System Status > Link Status) and best-effort email admins/board. Never
 * throws — callers return false/null regardless of whether this succeeds.
 */
export async function reportShopifyFailure(
    operation: string,
    error: unknown,
    context: Record<string, unknown>,
    emailIntroHtml: string,
): Promise<void> {
    await logIntegrationError("shopify", error, { operation, ...context });

    try {
        const admins = await prisma.person.findMany({
            where: {
                OR: [{ isSysadmin: true }, { isBoardMember: true }],
                email: { not: null },
                ...LIVE_PERSON,
            },
            select: { email: true }
        });

        const emailPromises = admins
            .map(a => a.email)
            .filter((e): e is string => typeof e === 'string' && e.length > 0)
            .map(email =>
                sendEmail(
                    email,
                    "Shopify Integration Error",
                    `<p>${emailIntroHtml}</p><p>Error details:</p><pre>${escapeHtml(error instanceof Error ? error.message : String(error))}</pre>`
                )
            );

        if (emailPromises.length > 0) {
            await Promise.all(emailPromises);
        }
    } catch (dbError) {
        console.error("Failed to send Shopify error notifications:", dbError);
    }
}

/**
 * Picks the inventory location from a `/locations.json` body: the first location
 * explicitly marked `active: true`, else null. Fails closed — an inactive or
 * unknown-state location 422s inventory writes, which hides the real cause.
 */
function pickActiveLocationId(locData: { locations?: Array<{ id?: number; active?: boolean }> }): number | null {
    return locData.locations?.find((l) => l.active === true)?.id ?? null;
}

/**
 * Set the initial absolute inventory (== maxParticipants) for one variant's
 * inventory_item_id. A capped program's variant is created inline with
 * inventory_management='shopify' + inventory_policy='deny' and Shopify's default
 * 0 available, so WITHOUT this the storefront immediately shows "Sold out". This
 * call is the only thing that lifts it off zero.
 *
 * Hardened against the two real-store failure modes that previously left products
 * silently sold out:
 *   - `/locations.json` returns deactivated + fulfillment-service locations in an
 *     arbitrary order; setting at an inactive one 422s. We pick an ACTIVE location,
 *     not blindly `locations[0]`.
 *   - a freshly-created inventory item is often not stocked at that location yet,
 *     so REST `set` 422s ("not stocked at location"). We `connect` it, then retry.
 *
 * Still never throws (a failure must not undo the created variant), but now RETURNS
 * whether stock was actually set and SURFACES failures to IntegrationErrorLog
 * (System Status → Link Status) — a sold-out product is visible instead of silent.
 */
async function setInitialShopifyInventory(
    storeDomain: string,
    accessToken: string,
    inventoryItemId: number | undefined,
    quantity: number,
    label: string,
): Promise<boolean> {
    const jsonHeaders = { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken };
    try {
        if (!inventoryItemId) {
            // The product-create response carried no inventory_item_id for this tracked
            // variant, so we can't set stock — it would ship sold out. Surface it.
            await logIntegrationError("shopify", new Error(`Variant '${label}' has no inventory_item_id; cannot set initial stock (product would be sold out)`), { operation: "setInitialShopifyInventory", label, quantity });
            return false;
        }

        const locRes = await shopifyFetch(`https://${storeDomain}/admin/api/${SHOPIFY_API_VERSION}/locations.json`, {
            headers: { 'X-Shopify-Access-Token': accessToken },
        }, "Shopify get locations");
        if (!locRes.ok) {
            await logIntegrationError("shopify", new Error(`locations.json returned ${locRes.status}`), { operation: "setInitialShopifyInventory", label, quantity });
            return false;
        }

        const locationId = pickActiveLocationId(await locRes.json());
        if (!locationId) {
            await logIntegrationError("shopify", new Error("no active Shopify location; cannot set inventory"), { operation: "setInitialShopifyInventory", label, quantity });
            return false;
        }

        // CONNECT FIRST, unconditionally (credit: @dkaygithub, #985). A variant freshly
        // minted with inventory_management:'shopify' is tracked but not yet *stocked* at
        // any location, and `set` does NOT reliably auto-connect it — it 422s ("not
        // stocked at the location"). Connecting first creates the inventory level (at 0)
        // so the `set` below can write the absolute quantity.
        //
        // Deliberately not "optimistic set, connect+retry on 422": that costs an extra
        // round trip on every capped create (the 422 is the norm for a new item, not the
        // exception) and, worse, makes the whole fix hinge on Shopify returning exactly
        // 422 — a different status and the product silently ships sold out again.
        // A 422 HERE just means the level already exists (e.g. a re-sync) → fall through.
        const connectRes = await shopifyFetch(`https://${storeDomain}/admin/api/${SHOPIFY_API_VERSION}/inventory_levels/connect.json`, {
            method: 'POST',
            headers: jsonHeaders,
            body: JSON.stringify({ location_id: locationId, inventory_item_id: inventoryItemId }),
        }, "Shopify connect inventory");
        if (!connectRes.ok && connectRes.status !== 422) {
            const connectBody = await connectRes.text();
            console.error(`[SHOPIFY] Failed to connect inventory item to location: ${connectRes.status}`, connectBody);
            await logIntegrationError("shopify", new Error(`inventory_levels/connect returned ${connectRes.status}: ${connectBody}`), { operation: "setInitialShopifyInventory", label, quantity, locationId });
            return false;
        }

        const setUrl = `https://${storeDomain}/admin/api/${SHOPIFY_API_VERSION}/inventory_levels/set.json`;
        const setBody = JSON.stringify({ location_id: locationId, inventory_item_id: inventoryItemId, available: quantity });
        const invRes = await shopifyFetch(setUrl, { method: 'POST', headers: jsonHeaders, body: setBody }, "Shopify set inventory");

        if (invRes.ok) {
            console.log(`[SHOPIFY] Set inventory for variant ${label} to ${quantity} at location ${locationId}`);
            return true;
        }
        const errBody = await invRes.text();
        console.error(`[SHOPIFY] Failed to set inventory: ${invRes.status}`, errBody);
        await logIntegrationError("shopify", new Error(`inventory_levels/set returned ${invRes.status}: ${errBody}`), { operation: "setInitialShopifyInventory", label, quantity, locationId });
        return false;
    } catch (invErr) {
        console.error("Failed to set Shopify inventory level:", invErr);
        await logIntegrationError("shopify", invErr, { operation: "setInitialShopifyInventory", label, quantity });
        return false;
    }
}

/**
 * Single-pool model (product decision 2026-07-06): mints ONE Shopify variant
 * per program, priced at the base/non-member rate — inventory IS the whole
 * program capacity, not a per-tier pool. Members buy the same variant and get
 * a per-enrollee discount code at checkout (see {@link mintMemberDiscountCode})
 * instead of a separate variant/pool. This is the creation path for every
 * program — both POST /api/programs and sync-shopify's repair route.
 */
export async function createShopifySingleVariantProgram(
    name: string,
    basePriceCents: number | null,
    maxParticipants: number | null = null,
): Promise<{ shopifyProductId: string; shopifyVariantId: string } | null> {
    if (!basePriceCents || basePriceCents <= 0) return null; // free program: no Shopify object needed

    // ENV GATE: LOCAL ONLY (shopifyMockActive() ⇔ CHECKIN_ENV=local). No real store,
    // so synthesize the variant id the real store would return — otherwise a paid
    // program stores a null variant and the checkout → webhook path can't match. The
    // id need not be globally unique: the inbound handler resolves the program by id,
    // then matches line-items against that program's own variant. dev/prod fall
    // through to the real Shopify Admin API call below.
    if (config.shopifyMockActive()) {
        const slug = name.replace(/\W+/g, "-").toLowerCase().slice(0, 24);
        return {
            shopifyProductId: `dev-mock-product-${slug}`,
            shopifyVariantId: `dev-mock-variant-${slug}`,
        };
    }

    const storeDomain = config.shopifyStoreDomain();
    const accessToken = await getAccessToken();

    if (!storeDomain || !accessToken) {
        console.warn("Shopify integration is disabled: Missing credentials or unable to obtain access token");
        return null;
    }

    // Hoisted so the catch can name an orphaned product (created, but variant/DB failed) for manual cleanup.
    let productId: string | number | null = null;

    try {
        // The variant goes INLINE in the product-create call. Creating the
        // product bare makes Shopify mint a "Default Title" variant (price $0,
        // requires_shipping true), and the follow-up POST /variants.json —
        // which has no option1 either — collides with it (422 "The variant
        // 'Default Title' already exists"). Net effect of the old two-call
        // shape: no variant id ever stored, and the orphaned product kept its
        // physical $0 default variant so checkout demanded a shipping address.
        const productRes = await shopifyFetch(`https://${storeDomain}/admin/api/${SHOPIFY_API_VERSION}/products.json`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Shopify-Access-Token': accessToken,
            },
            body: JSON.stringify({
                product: {
                    title: `${name} Program Enrollment`,
                    status: 'active',
                    product_type: "Educational Services",
                    variants: [{
                        price: (basePriceCents / 100).toFixed(2),
                        requires_shipping: false,
                        inventory_management: maxParticipants ? 'shopify' : null,
                        inventory_policy: maxParticipants ? 'deny' : 'continue',
                    }],
                }
            })
        }, "Shopify create product");

        if (!productRes.ok) {
            const errorData = await productRes.text();
            console.error(`[Shopify API Error] ${productRes.status} ${productRes.statusText}`, errorData);
            throw new Error(`Shopify API responded with status: ${productRes.status}`);
        }

        const productData = await productRes.json();
        productId = productData.product.id;

        // Unlike the legacy path, the single variant is the whole point here —
        // without its id the program can never match a webhook line-item, so a
        // missing variant is a hard failure (the catch names the orphan).
        const variant = productData.product.variants?.[0];
        if (!variant?.id) {
            throw new Error("Shopify product creation response is missing the created variant");
        }
        const variantId = variant.id.toString();

        if (maxParticipants) {
            await setInitialShopifyInventory(storeDomain, accessToken, variant.inventory_item_id, maxParticipants, "Standard");
        }

        return {
            shopifyProductId: productId!.toString(),
            shopifyVariantId: variantId,
        };
    } catch (error) {
        console.error("[Shopify Error] Failed to create single-variant product:", error);
        if (productId) {
            console.error("[Shopify] Orphaned product after variant failure, manual cleanup needed:", productId);
        }

        await reportShopifyFailure(
            "createShopifySingleVariantProgram",
            error,
            { program: name, orphanedProductId: productId ?? null },
            `An error occurred in the Shopify integration while creating the variant for program: <strong>${escapeHtml(name)}</strong>.`,
        );

        return null;
    }
}

/**
 * Shopify is the source of truth for program capacity (product decision 2026-07-06):
 * cap edits and the scholarship lifecycle (apply/refuse) propagate as relative
 * inventory adjustments. Called from PATCH /api/programs/[id] (maxParticipants
 * edits), POST /api/programs/[id]/request-payment-plan (apply, -1), and
 * POST /api/finance-ops/payment-plans/refuse (refusal, +1) — approval performs
 * NO Shopify operation (the applicant already holds the seat since apply-time).
 *
 * `shopifyVariantId` IS the program's whole capacity (single pool), so it is the
 * only id adjusted; a program without one has nothing to adjust and no-ops.
 *
 * RELATIVE (inventory_levels/adjust, `available_adjustment: delta`) is deliberate,
 * not absolute set: Shopify decrements `available` itself as seats sell, and an
 * absolute set here would require reconstructing how many seats already sold to
 * avoid clobbering that ledger. A relative delta rides on top of whatever
 * Shopify already has without the app needing to know that number.
 *
 * The schema doesn't persist inventory_item_id (only the variant id), so it's
 * resolved here per call via GET .../variants/{id}.json — one extra round trip,
 * acceptable for an admin/scholarship-triggered edit.
 *
 * Never throws: logs + emails the admin via reportShopifyFailure and returns
 * false, so the caller can surface a non-fatal warning.
 */
export async function adjustProgramInventory(
    program: { shopifyVariantId?: string | null },
    delta: number,
): Promise<boolean> {
    const variantId = program.shopifyVariantId;
    if (!variantId) return true;

    // See createShopifySingleVariantProgram for why this branch exists (CHECKIN_ENV=local mock).
    if (config.shopifyMockActive()) {
        console.log(`[SHOPIFY] (mock) Would adjust inventory by ${delta} for variant: ${variantId}`);
        return true;
    }

    const storeDomain = config.shopifyStoreDomain();
    const accessToken = await getAccessToken();

    if (!storeDomain || !accessToken) {
        await reportShopifyFailure(
            "adjustProgramInventory",
            new Error("Shopify credentials missing or access token unavailable"),
            { shopifyVariantId: variantId, delta },
            `Failed to adjust Shopify inventory (delta ${delta}) after a program capacity change.`,
        );
        return false;
    }

    try {
        const locRes = await shopifyFetch(`https://${storeDomain}/admin/api/${SHOPIFY_API_VERSION}/locations.json`, {
            headers: { 'X-Shopify-Access-Token': accessToken },
        }, "Shopify get locations");
        if (!locRes.ok) throw new Error(`Shopify locations lookup failed: ${locRes.status}`);
        const locationId = pickActiveLocationId(await locRes.json());
        if (!locationId) throw new Error("no active Shopify location");

        const variantRes = await shopifyFetch(`https://${storeDomain}/admin/api/${SHOPIFY_API_VERSION}/variants/${variantId}.json`, {
            headers: { 'X-Shopify-Access-Token': accessToken },
        }, "Shopify get variant");
        if (!variantRes.ok) throw new Error(`Shopify variant lookup failed for ${variantId}: ${variantRes.status}`);
        const variantData = await variantRes.json();
        const inventoryItemId = variantData.variant?.inventory_item_id;
        if (!inventoryItemId) throw new Error(`Shopify variant ${variantId} has no inventory_item_id`);

        const adjustRes = await shopifyFetch(`https://${storeDomain}/admin/api/${SHOPIFY_API_VERSION}/inventory_levels/adjust.json`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Shopify-Access-Token': accessToken,
            },
            body: JSON.stringify({
                location_id: locationId,
                inventory_item_id: inventoryItemId,
                available_adjustment: delta,
            }),
        }, "Shopify adjust inventory");
        if (!adjustRes.ok) {
            throw new Error(`Shopify inventory adjust failed for variant ${variantId}: ${adjustRes.status} ${await adjustRes.text()}`);
        }

        console.log(`[SHOPIFY] Adjusted inventory for variant ${variantId} by ${delta} at location ${locationId}`);

        return true;
    } catch (error) {
        console.error("[Shopify Error] Failed to adjust program inventory:", error);

        await reportShopifyFailure(
            "adjustProgramInventory",
            error,
            { shopifyVariantId: variantId, delta },
            `Failed to adjust Shopify inventory (delta ${delta}) after a program capacity change.`,
        );

        return false;
    }
}

/**
 * Mints a server-side, single-use fixed-amount discount code for one
 * enrollee's checkout. Single-pool programs ({@link Program.shopifyVariantId})
 * sell at the base/non-member price; an ACTIVE org member gets this code
 * appended to their cart link (`?discount=<code>`) to bring the price down to
 * the member rate. Interim mechanism —
 * docs/designs/SHOPIFY_MEMBER_SEGMENT_PRICING.md's segment-gated automatic
 * discount (its §5) is the planned upgrade once checkout identity is solved;
 * this mints one real Shopify object per checkout in the meantime.
 *
 * Implemented via GraphQL `discountCodeBasicCreate` (scope: write_discounts).
 * NOT the legacy REST price_rules API: that needs the separate
 * write_price_rules scope that neither store's app grants (the dev store
 * 403'd every mint until 2026-07-14), and Shopify has deprecated it anyway.
 * `appliesOnEachItem: true` carries the load-bearing 'each' semantics: a
 * member household enrolling N kids buys quantity N of the variant and every
 * seat gets the member price (amount-off-once would overcharge N-1 seats).
 *
 * ponytail: one discount code per enrollee/checkout — fine at Treehouse's
 * program-enrollment volume. Upgrade to the segment design above if that
 * stops being true.
 *
 * Never throws: a failure returns null so the caller falls back to an
 * undiscounted checkout link rather than blocking it (member pays full price
 * and can contact the board — better than a broken checkout).
 */
export async function mintMemberDiscountCode(
    programId: number,
    variantId: string,
    amountOffCents: number,
): Promise<string | null> {
    if (amountOffCents <= 0) return null;

    const code = `${programMemberCodePrefix(programId)}${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

    // See createShopifySingleVariantProgram for why this branch exists (CHECKIN_ENV=local mock).
    if (config.shopifyMockActive()) {
        console.log(`[SHOPIFY] (mock) Would mint discount code ${code} for program ${programId} (-$${(amountOffCents / 100).toFixed(2)})`);
        return code;
    }

    const storeDomain = config.shopifyStoreDomain();
    const accessToken = await getAccessToken();

    if (!storeDomain || !accessToken) {
        console.warn("Shopify integration is disabled: Missing credentials or unable to obtain access token");
        return null;
    }

    try {
        const startsAt = new Date();
        const endsAt = new Date(startsAt.getTime() + 48 * 60 * 60 * 1000); // ~48h, per design

        const mutation = `
            mutation MintMemberDiscount($discount: DiscountCodeBasicInput!) {
                discountCodeBasicCreate(basicCodeDiscount: $discount) {
                    codeDiscountNode { id }
                    userErrors { field message }
                }
            }`;
        const res = await shopifyFetch(`https://${storeDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Shopify-Access-Token': accessToken,
            },
            body: JSON.stringify({
                query: mutation,
                variables: {
                    discount: {
                        title: code,
                        code,
                        startsAt: startsAt.toISOString(),
                        endsAt: endsAt.toISOString(),
                        usageLimit: 1,
                        appliesOncePerCustomer: true,
                        customerSelection: { all: true },
                        customerGets: {
                            // appliesOnEachItem: the 'each' semantics (see doc comment).
                            value: { discountAmount: { amount: (amountOffCents / 100).toFixed(2), appliesOnEachItem: true } },
                            items: { products: { productVariantsToAdd: [`gid://shopify/ProductVariant/${variantId}`] } },
                        },
                    },
                },
            }),
        }, "Shopify mint member discount");
        if (!res.ok) {
            throw new Error(`Shopify discount create failed: ${res.status} ${await res.text()}`);
        }
        const data = await res.json();
        if (data.errors) throw new Error(`Shopify discount create GraphQL errors: ${JSON.stringify(data.errors)}`);
        const result = data.data?.discountCodeBasicCreate;
        if (result?.userErrors?.length) throw new Error(`Shopify discount create userErrors: ${JSON.stringify(result.userErrors)}`);
        if (!result?.codeDiscountNode?.id) throw new Error("Shopify discount create response missing codeDiscountNode id");

        console.log(`[SHOPIFY] Minted single-use discount code ${code} for program ${programId} (-$${(amountOffCents / 100).toFixed(2)}, expires ${endsAt.toISOString()})`);
        return code;
    } catch (error) {
        console.error("[Shopify Error] Failed to mint member discount code:", error);
        // Quieter than reportShopifyFailure (no admin email): a per-checkout mint
        // failure degrades gracefully to an undiscounted link (never blocks
        // checkout) rather than signaling a structural integration break —
        // logged for Link Status visibility, not urgent enough to page the board
        // every time.
        await logIntegrationError("shopify", error, {
            operation: "mintMemberDiscountCode",
            programId,
            variantId,
            amountOffCents,
        });
        return null;
    }
}
