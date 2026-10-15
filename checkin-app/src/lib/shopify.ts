// Shopify API integration using Client Credentials Grant (post-Jan 2026)
// Tokens expire after 24 hours and are cached in-memory.

import crypto from "crypto";
import prisma from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { sendEmail } from "@/lib/email";
import { escapeHtml } from "@/lib/email-templates/base";
import { logIntegrationError } from "@/lib/logger";
import { redactSecrets } from "@/lib/redact";
import { config } from "@/lib/config";
import { LIVE_PERSON } from "@/lib/person/filters";
import { householdMemberCodePrefix } from "@/lib/programs/memberDiscountCode";
import { saleStockDelta } from "@/lib/programs/saleState";
import { programVariantIds } from "@/lib/programs/variants";

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
 * (System Status > Link Status) and best-effort email admins/board, with the
 * error text redacted (lib/redact) since it leaves the app. Never
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
                    `<p>${emailIntroHtml}</p><p>Error details:</p><pre>${escapeHtml(redactSecrets(error instanceof Error ? error.message : String(error)))}</pre>`
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
 * Single-pool model (product decision 2026-07-06): mints ONE Shopify variant
 * per program, priced at the base/non-member rate — inventory IS the whole
 * program capacity, not a per-tier pool. Members buy the same variant and get
 * a per-enrollee discount code at checkout (see {@link mintMemberDiscountCode})
 * instead of a separate variant/pool. This is the creation path for every
 * program — both POST /api/programs and sync-shopify's repair route.
 *
 * A capped variant is created tracked at Shopify's default 0 available (sold
 * out); the caller lifts it to capacity with {@link adjustProgramInventory}
 * once the program row exists, so the initial stock takes the same locked path
 * as every other stock change.
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
        await reportShopifyFailure(
            "createShopifySingleVariantProgram",
            new Error("Shopify credentials are missing or no access token could be obtained"),
            { program: name },
            `Program <strong>${escapeHtml(name)}</strong> is priced, but its Shopify product was not created because Shopify is not configured. Its payment link will not work until a board member runs Sync to Shopify.`,
        );
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
 * Mints a program's hidden "reserved seat" product: same title (plus
 * " (reserved seat)"), price and single default variant as the public product,
 * but inventory UNTRACKED and status UNLISTED — off store search, collections and
 * recommendations, payable by direct cart link. Every app checkout links here, so
 * a family that already holds a claim can pay when the public variant shows 0;
 * the app's seat count is the only gate. docs/rules/programs.md.
 *
 * REST creates it (published to the Online Store, as the public product is) as a
 * DRAFT; GraphQL `productUpdate` then sets UNLISTED, a status the REST Product
 * resource does not have. If that second call fails the draft is reported as an
 * orphan and nothing is returned, so an untracked product is never left listed.
 */
export async function createClaimantProduct(
    name: string,
    basePriceCents: number | null,
): Promise<{ claimantShopifyProductId: string; claimantShopifyVariantId: string } | null> {
    if (!basePriceCents || basePriceCents <= 0) return null;

    // See createShopifySingleVariantProgram for why this branch exists (CHECKIN_ENV=local mock).
    if (config.shopifyMockActive()) {
        const slug = name.replace(/\W+/g, "-").toLowerCase().slice(0, 24);
        return {
            claimantShopifyProductId: `dev-mock-claimant-product-${slug}`,
            claimantShopifyVariantId: `dev-mock-claimant-variant-${slug}`,
        };
    }

    const storeDomain = config.shopifyStoreDomain();
    const accessToken = await getAccessToken();
    if (!storeDomain || !accessToken) {
        console.warn("Shopify integration is disabled: Missing credentials or unable to obtain access token");
        return null;
    }
    const headers = { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken };

    let productId: string | null = null;
    try {
        const productRes = await shopifyFetch(`https://${storeDomain}/admin/api/${SHOPIFY_API_VERSION}/products.json`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                product: {
                    title: `${name} Program Enrollment (reserved seat)`,
                    status: 'draft',
                    published: true,
                    product_type: "Educational Services",
                    variants: [{
                        price: (basePriceCents / 100).toFixed(2),
                        requires_shipping: false,
                        inventory_management: null,
                        inventory_policy: 'continue',
                    }],
                },
            }),
        }, "Shopify create claimant product");
        if (!productRes.ok) {
            throw new Error(`Shopify API responded with status: ${productRes.status} ${await productRes.text()}`);
        }
        const product = (await productRes.json()).product;
        productId = product?.id?.toString() ?? null;
        const variantId = product?.variants?.[0]?.id?.toString();
        if (!productId || !variantId) throw new Error("Shopify claimant product response is missing the product or variant id");

        const mutation = `
            mutation UnlistClaimantProduct($product: ProductUpdateInput!) {
                productUpdate(product: $product) {
                    product { id status }
                    userErrors { field message }
                }
            }`;
        const res = await shopifyFetch(`https://${storeDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                query: mutation,
                variables: { product: { id: `gid://shopify/Product/${productId}`, status: 'UNLISTED' } },
            }),
        }, "Shopify unlist claimant product");
        if (!res.ok) throw new Error(`Shopify productUpdate failed: ${res.status} ${await res.text()}`);
        const data = await res.json();
        if (data.errors) throw new Error(`Shopify productUpdate GraphQL errors: ${JSON.stringify(data.errors)}`);
        const result = data.data?.productUpdate;
        if (result?.userErrors?.length) throw new Error(`Shopify productUpdate userErrors: ${JSON.stringify(result.userErrors)}`);
        if (result?.product?.status !== 'UNLISTED') {
            throw new Error(`Shopify productUpdate left status ${result?.product?.status ?? "missing"}, expected UNLISTED`);
        }

        return { claimantShopifyProductId: productId, claimantShopifyVariantId: variantId };
    } catch (error) {
        console.error("[Shopify Error] Failed to create claimant product:", error);
        await reportShopifyFailure(
            "createClaimantProduct",
            error,
            { program: name, orphanedProductId: productId },
            `An error occurred in the Shopify integration while creating the reserved-seat product for program: <strong>${escapeHtml(name)}</strong>.`,
        );
        return null;
    }
}

/**
 * Admin API version for the program-stock GraphQL path. From 2026-04,
 * inventory mutations require `@idempotent(key:)`.
 */
export const SHOPIFY_INVENTORY_API_VERSION = "2026-04";

/** A stock lease outlives its push's cap by this much, so it can't expire under a writer still inside its cap. */
const STOCK_LEASE_SLACK_MS = 30_000;
/** How often a writer re-tries a busy lease. */
const STOCK_LEASE_POLL_MS = 250;

/**
 * @internal Tests shrink these. A cap bounds one push, lease wait included: a user
 * request waits `requestCapMs`, a webhook or job `capMs`.
 */
export const programStockTiming = { capMs: 3 * 60_000, requestCapMs: 15_000, maxBackoffMs: 15_000 };

/** Shopify keeps an idempotency key 24 h; a pending write older than this is not resent (it could apply twice) but parked as unconfirmed. */
const PENDING_WRITE_RESEND_LIMIT_MS = 23 * 60 * 60_000;

/** In the IntegrationErrorLog message written when a stock change is parked as unconfirmed. */
const UNCONFIRMED_LOG_MARK = "could not be confirmed";

/** Codes that mean "not settled yet — resend the same request". */
const TRANSIENT_CODES = new Set(["THROTTLED", "INTERNAL_SERVER_ERROR", "TIMEOUT", "SERVICE_UNAVAILABLE", "IDEMPOTENCY_CONCURRENT_REQUEST"]);

/** Shopify gave no settled answer before the cap: the request may still land. */
class StockWriteUnsettledError extends Error {}

/** The exact write sent under one idempotency key, persisted so a resend reuses identical parameters. */
interface PendingStockWrite {
    key: string;
    reason: string;
    /** What the write changes Shopify's `available` by. */
    delta: number;
    /** How much of the carry the write takes; if it lands, any difference stays owed. */
    owedPart: number;
    inventoryItemId: string;
    locationId: string;
    sentAt: string;
}

interface GqlBody<T> {
    data?: T;
    errors?: { message?: string; extensions?: { code?: string } }[];
}
/** One GraphQL round trip. Throws only on a transport failure (network, our timeout). */
type Gql = (query: string, variables: Record<string, unknown>) => Promise<{ status: number; body: unknown }>;

type UserErrors = { userErrors: { code?: string; message: string }[] };
type ReadData = {
    locations: { nodes: { id: string; isActive: boolean }[] };
    productVariant: {
        inventoryItem: {
            id: string;
            inventoryLevels: { nodes: { location: { id: string }; quantities: { quantity: number }[] }[] };
        } | null;
    } | null;
};

const READ_STOCK = `
    query ProgramStockRead($variantId: ID!) {
        locations(first: 50) { nodes { id isActive } }
        productVariant(id: $variantId) {
            inventoryItem {
                id
                inventoryLevels(first: 50) { nodes { location { id } quantities(names: ["available"]) { quantity } } }
            }
        }
    }`;

const ACTIVATE_STOCK = `
    mutation ProgramStockActivate($inventoryItemId: ID!, $locationId: ID!, $idempotencyKey: String!) {
        inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId) @idempotent(key: $idempotencyKey) {
            inventoryLevel { id }
            userErrors { field message }
        }
    }`;

const ADJUST_STOCK = `
    mutation ProgramStockAdjust($input: InventoryAdjustQuantitiesInput!, $idempotencyKey: String!) {
        inventoryAdjustQuantities(input: $input) @idempotent(key: $idempotencyKey) {
            inventoryAdjustmentGroup { id }
            userErrors { code field message }
        }
    }`;

function shopifyGraphql(storeDomain: string, accessToken: string): Gql {
    return async (query, variables) => {
        const res = await shopifyFetch(`https://${storeDomain}/admin/api/${SHOPIFY_INVENTORY_API_VERSION}/graphql.json`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
            body: JSON.stringify({ query, variables }),
        }, "Shopify program stock");
        // A 5xx gateway page is not JSON; its status alone marks it transient.
        const body: unknown = await res.json().catch(() => ({}));
        return { status: res.status, body };
    };
}

/** CHECKIN_ENV=local stand-in: one location, stock per inventory item in memory, idempotency keys honoured. */
const mockStockByItem = new Map<string, number>();
const mockAppliedKeys = new Set<string>();
const MOCK_LOCATION_ID = "gid://shopify/Location/dev-mock";
const mockShopifyGraphql: Gql = async (query, variables) => {
    const reply = (data: unknown) => ({ status: 200, body: { data } });
    if (query.includes("ProgramStockRead")) {
        const itemId = `gid://shopify/InventoryItem/for-${String(variables.variantId)}`;
        const available = mockStockByItem.get(itemId);
        const levels = available === undefined ? [] : [{ location: { id: MOCK_LOCATION_ID }, quantities: [{ quantity: available }] }];
        return reply({
            locations: { nodes: [{ id: MOCK_LOCATION_ID, isActive: true }] },
            productVariant: { inventoryItem: { id: itemId, inventoryLevels: { nodes: levels } } },
        });
    }
    if (query.includes("ProgramStockActivate")) {
        mockStockByItem.set(String(variables.inventoryItemId), 0);
        return reply({ inventoryActivate: { userErrors: [] } });
    }
    const key = String(variables.idempotencyKey);
    const input = variables.input as { changes: { inventoryItemId: string; delta: number }[] };
    const { inventoryItemId, delta } = input.changes[0];
    if (!mockAppliedKeys.has(key)) {
        mockAppliedKeys.add(key);
        const before = mockStockByItem.get(inventoryItemId) ?? 0;
        mockStockByItem.set(inventoryItemId, before + delta);
        console.log(`[SHOPIFY] (mock) Adjusted available for ${inventoryItemId}: ${before} -> ${before + delta} (key ${key})`);
    }
    return reply({ inventoryAdjustQuantities: { userErrors: [] } });
};

/**
 * Send one request until Shopify gives a settled answer: resend the SAME variables
 * (so the same idempotency key) on a transport failure, 5xx, 429 or a transient
 * GraphQL code, with capped exponential backoff, until `deadline`. Throws on a
 * hard error or when the deadline passes unsettled.
 */
async function untilSettled<T>(
    gql: Gql,
    query: string,
    variables: Record<string, unknown>,
    deadline: number,
    stillRunning: (data: T) => boolean = () => false,
): Promise<T> {
    let lastError = "no reply";
    for (let attempt = 0; ; attempt++) {
        let reply: { status: number; body: GqlBody<T> } | null = null;
        try {
            const raw = await gql(query, variables);
            reply = { status: raw.status, body: raw.body as GqlBody<T> };
        } catch (err) {
            lastError = err instanceof Error ? err.message : String(err);
        }
        if (reply) {
            const { status, body } = reply;
            const transient = status >= 500 || status === 429
                || (body.errors ?? []).some((e) => TRANSIENT_CODES.has(e.extensions?.code ?? ""))
                || (body.data !== undefined && stillRunning(body.data));
            if (!transient) {
                if (status >= 400 || body.errors?.length || body.data === undefined) {
                    throw new Error(`Shopify GraphQL ${status}: ${JSON.stringify(body.errors ?? body)}`);
                }
                return body.data;
            }
            lastError = `HTTP ${status} ${JSON.stringify(body.errors ?? "IDEMPOTENCY_CONCURRENT_REQUEST")}`;
        }
        const wait = Math.min(1000 * 2 ** attempt, programStockTiming.maxBackoffMs);
        if (Date.now() + wait > deadline) {
            throw new StockWriteUnsettledError(`Shopify did not settle within ${programStockTiming.capMs}ms: ${lastError}`);
        }
        await new Promise((resolve) => setTimeout(resolve, wait));
    }
}

async function readStock(gql: Gql, variantId: string, deadline: number) {
    const data = await untilSettled<ReadData>(gql, READ_STOCK, { variantId: `gid://shopify/ProductVariant/${variantId}` }, deadline);
    // Fails closed: an inactive or unknown-state location rejects inventory writes.
    const locationId = data.locations.nodes.find((l) => l.isActive)?.id;
    if (!locationId) throw new Error("no active Shopify location");
    const item = data.productVariant?.inventoryItem;
    if (!item) throw new Error(`Shopify variant ${variantId} not found or has no inventory item`);
    const level = item.inventoryLevels.nodes.find((n) => n.location.id === locationId);
    // null = the item is not stocked at the location yet (a freshly created variant).
    return { inventoryItemId: item.id, locationId, available: level ? (level.quantities[0]?.quantity ?? 0) : null };
}

/**
 * Send one recorded delta with `inventoryAdjustQuantities` and its idempotency key.
 * Shopify dedupes this mutation by key (dev store, 2026-10-14): a resend of a write
 * that already landed returns its original result instead of applying it again, and
 * a resend of one that failed returns the original error. So the reply is always
 * definite: "applied", or a hard error (thrown), which means it did not apply.
 */
async function sendStockWrite(gql: Gql, write: PendingStockWrite, deadline: number): Promise<"applied"> {
    const variables = {
        input: {
            name: "available",
            reason: "correction",
            changes: [{
                inventoryItemId: write.inventoryItemId,
                locationId: write.locationId,
                delta: write.delta,
                // Deltas commute with store sales, so no compare: the key is the guard.
                changeFromQuantity: null,
            }],
        },
        idempotencyKey: write.key,
    };
    const codesOf = (d: { inventoryAdjustQuantities?: UserErrors }) => d.inventoryAdjustQuantities?.userErrors.map((e) => e.code ?? "") ?? [];
    const data = await untilSettled<{ inventoryAdjustQuantities?: UserErrors }>(
        gql, ADJUST_STOCK, variables, deadline,
        (d) => codesOf(d).includes("IDEMPOTENCY_CONCURRENT_REQUEST"),
    );
    if (codesOf(data).length === 0) return "applied";
    throw new Error(`inventoryAdjustQuantities userErrors: ${JSON.stringify(data.inventoryAdjustQuantities?.userErrors)}`);
}

/** How much of a settled write the app still owes: what it wanted minus what landed. */
function stillOwed(write: PendingStockWrite, outcome: "applied" | "notApplied"): number {
    return outcome === "applied" ? write.owedPart - write.delta : write.owedPart;
}

/** Take the program's stock lease if it is free or expired. One short statement; no transaction stays open. */
async function takeStockLease(programId: number, capMs: number): Promise<string | null> {
    const token = crypto.randomUUID();
    const now = new Date();
    const { count } = await prisma.program.updateMany({
        where: { id: programId, OR: [{ shopifyStockLeaseUntil: null }, { shopifyStockLeaseUntil: { lt: now } }] },
        data: { shopifyStockLeaseUntil: new Date(now.getTime() + capMs + STOCK_LEASE_SLACK_MS), shopifyStockLeaseToken: token },
    });
    return count === 1 ? token : null;
}

/** The lease expired under this writer and another took it; this writer stops before sending anything else. */
class StockLeaseLostError extends Error {}

/** Change the stock bookkeeping, only while `token` still holds the program's lease. */
async function bookStock(programId: number, token: string, data: Prisma.ProgramUpdateManyMutationInput): Promise<void> {
    const { count } = await prisma.program.updateMany({ where: { id: programId, shopifyStockLeaseToken: token }, data });
    if (count !== 1) throw new StockLeaseLostError(`lost the Shopify stock lease for program ${programId}`);
}

/**
 * Send a write already booked as pending and book how it settled. A write that may
 * still land (no settled answer before the cap) stays pending, for the next push to
 * resend under its key; a hard error settled it unapplied, so it goes back to owed.
 */
async function sendBooked(gql: Gql, programId: number, token: string, write: PendingStockWrite, deadline: number): Promise<void> {
    try {
        await sendStockWrite(gql, write, deadline);
    } catch (error) {
        if (!(error instanceof StockWriteUnsettledError)) {
            await bookStock(programId, token, { shopifyStockCarry: { increment: stillOwed(write, "notApplied") }, shopifyStockPendingWrite: null });
        }
        throw error;
    }
    await bookStock(programId, token, { shopifyStockCarry: { increment: stillOwed(write, "applied") }, shopifyStockPendingWrite: null });
}

interface DrainResult {
    error: unknown;
    expiredKey: string | null;
}

/**
 * Holding the lease: settle a write a failed push left pending, then land the
 * whole owed carry as one keyed delta, looping so deltas recorded meanwhile land
 * too. Each write is booked as pending (and its amount taken out of the carry)
 * BEFORE it is sent, and its outcome booked after, so a crash leaves it to be
 * resent under its key. Stock is never taken below 0: the shortfall stays as a
 * negative carry. Reports, never throws.
 */
async function drainStock(
    gql: Gql,
    programId: number,
    variantId: string,
    reason: string,
    token: string,
    deadline: number,
    target?: number,
): Promise<DrainResult> {
    const result: DrainResult = { error: null, expiredKey: null };
    try {
        for (;;) {
            const row = await prisma.program.findUnique({
                where: { id: programId },
                select: { shopifyStockCarry: true, shopifyStockPendingWrite: true, startAt: true, offSaleAt: true, saleEndedAt: true },
            });
            if (!row) throw new Error(`program ${programId} not found`);

            if (row.shopifyStockPendingWrite) {
                const pending = JSON.parse(row.shopifyStockPendingWrite) as PendingStockWrite;
                if (Date.now() - Date.parse(pending.sentAt) >= PENDING_WRITE_RESEND_LIMIT_MS) {
                    // Shopify may have forgotten the key, so a resend could apply twice: a person settles it.
                    result.expiredKey = pending.key;
                    await bookStock(programId, token, {
                        shopifyStockCarry: { increment: pending.owedPart - pending.delta },
                        shopifyStockUnconfirmed: { increment: pending.delta },
                        shopifyStockPendingWrite: null,
                    });
                } else {
                    await sendBooked(gql, programId, token, pending, deadline);
                    console.log(`[SHOPIFY] Program ${programId} settled pending stock write ${pending.key}`);
                }
                continue;
            }

            if (target === undefined && row.shopifyStockCarry === 0) break;
            const stock = await readStock(gql, variantId, deadline);
            let available = stock.available;
            if (available === null) {
                await untilSettled(gql, ACTIVATE_STOCK, {
                    inventoryItemId: stock.inventoryItemId,
                    locationId: stock.locationId,
                    idempotencyKey: `program-${programId}-activate-${crypto.randomUUID()}`,
                }, deadline);
                available = 0;
            }
            if (target !== undefined) {
                // An absolute target replaces whatever was owed before it, as the delta from what Shopify shows now.
                await bookStock(programId, token, { shopifyStockCarry: target - available });
                target = undefined;
                continue;
            }

            // After the sale has ended, owed stock may only come off sale, never go back on.
            const total = saleStockDelta(row, row.shopifyStockCarry);
            if (total !== row.shopifyStockCarry) {
                console.log(`[SHOPIFY] Program ${programId} sale has ended: dropping ${row.shopifyStockCarry - total} owed seat(s) instead of putting them back on sale`);
                await bookStock(programId, token, { shopifyStockCarry: { increment: total - row.shopifyStockCarry } });
            }
            if (total === 0) break;
            // Never below 0: held at 0, the shortfall stays owed as a negative carry.
            // ponytail: a store sale between this read and the adjust can still take it
            // to -1 (sold out either way); the drift check will see that gap.
            const delta = Math.max(total, -available);
            if (delta === 0) break;

            const write: PendingStockWrite = {
                key: `program-${programId}-${reason}-${crypto.randomUUID()}`,
                reason,
                delta,
                owedPart: total,
                inventoryItemId: stock.inventoryItemId,
                locationId: stock.locationId,
                sentAt: new Date().toISOString(),
            };
            await bookStock(programId, token, { shopifyStockCarry: { increment: -total }, shopifyStockPendingWrite: JSON.stringify(write) });
            await sendBooked(gql, programId, token, write, deadline);
            console.log(`[SHOPIFY] Program ${programId} stock ${available} -> ${available + delta} (${reason}, key ${write.key})`);
            // Held at 0: what's left is the over-capacity shortfall, nothing more to write.
            if (delta !== total) break;
        }
    } catch (error) {
        result.error = error;
    }
    return result;
}

/** The program-stock GraphQL client: the local mock, or the live store; null without credentials. */
async function stockGql(): Promise<Gql | null> {
    if (config.shopifyMockActive()) return mockShopifyGraphql;
    const storeDomain = config.shopifyStoreDomain();
    const accessToken = await getAccessToken();
    return storeDomain && accessToken ? shopifyGraphql(storeDomain, accessToken) : null;
}

async function alertStockPush(programId: number, variantId: string, reason: string, error: unknown): Promise<void> {
    await reportShopifyFailure(
        "adjustProgramInventory",
        error,
        { programId, shopifyVariantId: variantId, reason },
        `Shopify stock for program ${programId} needs a push (${escapeHtml(reason)}): a change could not be confirmed and is still owed. The daily Shopify reconcile retries it.`,
    );
}

/**
 * Land whatever the program owes Shopify, under its stock lease. Waits for a busy
 * lease by polling (no connection held) until the cap. Sets or clears
 * `shopifyStockPushNeededAt`, alerts the board, never throws. Returns false when
 * something is still owed or unconfirmed because of a failure.
 */
async function pushProgramStock(
    programId: number,
    variantId: string,
    reason: string,
    capMs: number,
    carryBefore: number,
    target?: number,
): Promise<boolean> {
    const deadline = Date.now() + capMs;
    try {
        const gql = await stockGql();
        if (!gql) {
            await prisma.program.update({ where: { id: programId }, data: { shopifyStockPushNeededAt: new Date() } });
            await alertStockPush(programId, variantId, reason, new Error("Shopify credentials missing or access token unavailable"));
            return false;
        }

        let token = await takeStockLease(programId, capMs);
        while (!token && Date.now() + STOCK_LEASE_POLL_MS < deadline) {
            await new Promise((resolve) => setTimeout(resolve, STOCK_LEASE_POLL_MS));
            token = await takeStockLease(programId, capMs);
        }
        if (!token) {
            // The holder re-reads the carry before it lets go, so it usually lands this delta too.
            await prisma.program.update({ where: { id: programId }, data: { shopifyStockPushNeededAt: new Date() } });
            console.warn(`[SHOPIFY] Program ${programId} stock lease stayed busy for ${capMs}ms; the delta stays owed.`);
            return false;
        }

        const result = await drainStock(gql, programId, variantId, reason, token, deadline, target);
        const row = await prisma.program.findUnique({
            where: { id: programId },
            select: { shopifyStockCarry: true, shopifyStockUnconfirmed: true, shopifyStockPendingWrite: true, shopifyStockPushNeededAt: true },
        });
        const carryAfter = row?.shopifyStockCarry ?? 0;
        const needsPush = result.error !== null || carryAfter !== 0 || (row?.shopifyStockUnconfirmed ?? 0) !== 0 || !!row?.shopifyStockPendingWrite;
        await prisma.program.updateMany({
            where: { id: programId, shopifyStockLeaseToken: token },
            data: {
                shopifyStockLeaseUntil: null,
                shopifyStockLeaseToken: null,
                shopifyStockPushNeededAt: needsPush ? (row?.shopifyStockPushNeededAt ?? new Date()) : null,
            },
        });

        if (result.error) {
            console.error(`[Shopify Error] Failed to push stock for program ${programId}:`, result.error);
            await alertStockPush(programId, variantId, reason, result.error);
        } else if (carryAfter < Math.min(0, carryBefore)) {
            const over = -carryAfter;
            await reportShopifyFailure(
                "adjustProgramInventory",
                new Error(`program ${programId} is over capacity by ${over}; Shopify held at 0`),
                { programId, shopifyVariantId: variantId, reason, carry: carryAfter },
                `Program ${programId} is over capacity by ${over} seat(s), so its Shopify stock is held at 0. The next ${over} seat(s) given back will not go on sale.`,
            );
        }
        if (result.expiredKey) {
            // The board settles it on Revenue Ops > Unconfirmed Shopify stock (settleUnconfirmedStock);
            // that screen dates each row by this log entry's message.
            await reportShopifyFailure(
                "adjustProgramInventory",
                new Error(`stock write ${result.expiredKey} for program ${programId} ${UNCONFIRMED_LOG_MARK}`),
                { programId, shopifyVariantId: variantId, idempotencyKey: result.expiredKey, unconfirmed: row?.shopifyStockUnconfirmed ?? null },
                `A Shopify stock write for program ${programId} (key ${escapeHtml(result.expiredKey)}) stayed unsettled for a day, so Shopify could not say whether it landed. It will not be re-sent. Check the program's stock in Shopify by hand, then settle it on Revenue Ops &gt; Unconfirmed Shopify stock.`,
            );
        }
        return result.error === null && result.expiredKey === null;
    } catch (error) {
        // The DB failed mid-push; the lease expires on its own and the carry keeps what was not booked.
        console.error(`[Shopify Error] Stock push for program ${programId} failed:`, error);
        await alertStockPush(programId, variantId, reason, error);
        return false;
    }
}

/** Options for {@link adjustProgramInventory}. */
export interface StockWriteOptions {
    /** A user request: the push, lease wait included, is capped at `programStockTiming.requestCapMs`. */
    inRequest?: boolean;
    /** A webhook: record the delta and push in the background, so the reply stays inside Shopify's 5 s timeout. */
    deferred?: boolean;
}

/**
 * The ONE writer of a program's public Shopify stock: every app-initiated change
 * (initial stock, cap edits, scholarship holds and releases, comps, activation,
 * reconciler heals) comes through here. The caller decides the delta; this only
 * decides how it is written.
 *
 * The delta is first added to `Program.shopifyStockCarry` (what the app owes
 * Shopify), then a push lands the whole carry under a per-program lease (one
 * writer per program; no DB transaction is held across a Shopify call). Each
 * write is one delta, `inventoryAdjustQuantities` (API 2026-04) with an
 * idempotency key and no compare: deltas commute with store sales. A timeout,
 * 5xx or IDEMPOTENCY_CONCURRENT_REQUEST resends the SAME request until Shopify
 * settles or the cap passes (15 s in a user request, 3 min otherwise). Shopify
 * dedupes this mutation by key (dev store, 2026-10-14), so a resend of a write
 * that already landed is not applied twice. A write left unsettled is resent
 * under its key by the next push; after a day (the key's lifetime) it is parked
 * as unconfirmed for the board instead.
 *
 * Stock never goes below 0: an over-capacity shortfall stays as a negative carry
 * that later positive deltas pay down before any seat goes back on sale.
 *
 * Never throws. Returns whether the change landed; {@link changeProgramStock}
 * also says whether it was recorded. Whatever doesn't land stays owed and flagged
 * (`shopifyStockPushNeededAt`); the board is emailed; the daily reconcile-shopify
 * job re-pushes it ({@link healProgramStock}).
 */
export async function adjustProgramInventory(
    program: { id: number; shopifyVariantId?: string | null },
    delta: number,
    reason: string,
    options: StockWriteOptions = {},
): Promise<boolean> {
    return (await changeProgramStock(program, delta, reason, options)).landed;
}

/** What became of a stock change: `recorded` = owed in the carry (it will land), `landed` = confirmed in Shopify. */
export interface StockChange {
    recorded: boolean;
    landed: boolean;
}

/**
 * {@link adjustProgramInventory}, telling "recorded but not yet confirmed" apart
 * from "not recorded at all". A caller that marks a seat as taken out of stock
 * (a comp, a scholarship hold) keys on `recorded`: once the delta is in the carry
 * it lands later (next push or the daily heal) even when this push failed.
 */
export async function changeProgramStock(
    program: { id: number; shopifyVariantId?: string | null },
    delta: number,
    reason: string,
    options: StockWriteOptions = {},
): Promise<StockChange> {
    const variantId = program.shopifyVariantId;
    if (!variantId || delta === 0) return { recorded: true, landed: true };
    if (config.shopifyMockActive()) console.log(`[SHOPIFY] (mock) Would adjust inventory by ${delta} for variant: ${variantId}`);

    let carryBefore: number;
    try {
        const { shopifyStockCarry } = await prisma.program.update({
            where: { id: program.id },
            data: { shopifyStockCarry: { increment: delta } },
            select: { shopifyStockCarry: true },
        });
        carryBefore = shopifyStockCarry - delta;
    } catch (error) {
        await alertStockPush(program.id, variantId, reason, error);
        return { recorded: false, landed: false };
    }

    if (options.deferred) {
        // ponytail: fire-and-forget on this server process. A restart drops the push;
        // the delta stays owed in the carry and the daily heal lands it.
        void pushProgramStock(program.id, variantId, reason, programStockTiming.capMs, carryBefore);
        return { recorded: true, landed: true };
    }
    const capMs = options.inRequest ? programStockTiming.requestCapMs : programStockTiming.capMs;
    return { recorded: true, landed: await pushProgramStock(program.id, variantId, reason, capMs, carryBefore) };
}

/**
 * Push whatever a program already owes, in the background (no new delta). The
 * refund webhook calls it so a restocked seat is netted against an over-capacity
 * carry right away instead of selling until the daily heal.
 */
export async function nudgeProgramStock(program: { id: number; shopifyVariantId: string }): Promise<void> {
    // No new delta, so no over-capacity alert: a restock only pays down an existing shortfall.
    void pushProgramStock(program.id, program.shopifyVariantId, "restock", programStockTiming.capMs, Number.NEGATIVE_INFINITY);
}

/**
 * Re-push every program the stock writer left owing (flagged, a write that may
 * still land, or a carry). The daily reconcile-shopify job calls it. Never throws.
 */
export async function healProgramStock(): Promise<{ checked: number; settled: number }> {
    // ponytail: the periodic drift check (recommendation §4, waiting on the board's
    // store decision) will also read shopifyStockPushNeededAt; until then this is its only reader.
    const programs = await prisma.program.findMany({
        where: {
            shopifyVariantId: { not: null },
            OR: [
                { shopifyStockPushNeededAt: { not: null } },
                { shopifyStockPendingWrite: { not: null } },
                { shopifyStockCarry: { not: 0 } },
            ],
        },
        select: { id: true, shopifyVariantId: true, shopifyStockCarry: true },
    });
    let settled = 0;
    for (const program of programs) {
        if (!program.shopifyVariantId) continue;
        if (await pushProgramStock(program.id, program.shopifyVariantId, "heal", programStockTiming.capMs, program.shopifyStockCarry)) settled++;
    }
    return { checked: programs.length, settled };
}

/** A program's parked stock change, as the board's settle screen shows it. */
export interface UnconfirmedStockRow {
    programId: number;
    programName: string;
    unconfirmed: number;
    carry: number;
    /** When the last write was parked (its IntegrationErrorLog row); null once that row is purged. */
    unconfirmedSince: Date | null;
    /** Shopify's `available` now; null when it can't be read within a few seconds. */
    shopifyAvailable: number | null;
}

/** Bounds the board screen's Shopify read per program. */
const UNCONFIRMED_READ_CAP_MS = 5_000;

/** Every program with a parked (unconfirmed) stock change. Never writes. */
export async function listUnconfirmedStock(): Promise<UnconfirmedStockRow[]> {
    const programs = await prisma.program.findMany({
        where: { shopifyStockUnconfirmed: { not: 0 } },
        select: { id: true, name: true, shopifyVariantId: true, shopifyStockUnconfirmed: true, shopifyStockCarry: true },
        orderBy: { id: "asc" },
    });
    if (programs.length === 0) return [];

    const logs = await prisma.integrationErrorLog.findMany({
        where: { source: "shopify", message: { contains: UNCONFIRMED_LOG_MARK } },
        select: { timestamp: true, context: true },
        orderBy: { timestamp: "desc" },
    });
    const since = new Map<number, Date>();
    for (const { timestamp, context } of logs) {
        const programId = context && typeof context === "object" && !Array.isArray(context) ? context.programId : undefined;
        if (typeof programId === "number" && !since.has(programId)) since.set(programId, timestamp);
    }

    const gql = await stockGql().catch(() => null);
    const available = async (variantId: string | null): Promise<number | null> => {
        if (!gql || !variantId) return null;
        try {
            return (await readStock(gql, variantId, Date.now() + UNCONFIRMED_READ_CAP_MS)).available;
        } catch {
            return null;
        }
    };
    return Promise.all(programs.map(async (p) => ({
        programId: p.id,
        programName: p.name,
        unconfirmed: p.shopifyStockUnconfirmed,
        carry: p.shopifyStockCarry,
        unconfirmedSince: since.get(p.id) ?? null,
        shopifyAvailable: await available(p.shopifyVariantId),
    })));
}

/** "landed": Shopify has the change, so it is dropped. "notLanded": it goes back into the owed carry. */
export type UnconfirmedStockChoice = "landed" | "notLanded";
export type SettleUnconfirmedOutcome = { carry: number } | { refused: "notFound" | "busy" | "stale" };

/** How long the settle step holds the program's stock lease (it makes no Shopify call). */
const SETTLE_LEASE_MS = 10_000;

/**
 * A board member settles a program's unconfirmed stock change after checking
 * Shopify by hand. Under the program's stock lease, in one transaction: refuses
 * when the amount is no longer `expected` (stale page), else zeroes it, adds it
 * to the carry for "notLanded", and writes the AuditLog row. "landed" makes no
 * Shopify call; "notLanded" then nudges a push so the carry lands as a keyed delta.
 */
export async function settleUnconfirmedStock(
    programId: number,
    expected: number,
    choice: UnconfirmedStockChoice,
    actorId: number,
): Promise<SettleUnconfirmedOutcome> {
    const token = await takeStockLease(programId, SETTLE_LEASE_MS);
    if (!token) {
        return { refused: (await prisma.program.count({ where: { id: programId } })) === 0 ? "notFound" : "busy" };
    }
    let settled: { carry: number; variantId: string | null } | null;
    try {
        settled = await prisma.$transaction(async (tx) => {
            const { count } = await tx.program.updateMany({
                where: { id: programId, shopifyStockLeaseToken: token, shopifyStockUnconfirmed: expected },
                data: choice === "landed"
                    ? { shopifyStockUnconfirmed: 0 }
                    : { shopifyStockUnconfirmed: 0, shopifyStockCarry: { increment: expected } },
            });
            if (count !== 1) return null;
            const row = await tx.program.findUniqueOrThrow({
                where: { id: programId },
                select: { shopifyStockCarry: true, shopifyVariantId: true },
            });
            await tx.auditLog.create({
                data: {
                    actorId,
                    action: "EDIT",
                    tableName: "Program",
                    affectedEntityId: programId,
                    oldData: { shopifyStockUnconfirmed: expected },
                    newData: { settledUnconfirmedStock: choice, amount: expected, shopifyStockUnconfirmed: 0, shopifyStockCarry: row.shopifyStockCarry },
                },
            });
            return { carry: row.shopifyStockCarry, variantId: row.shopifyVariantId };
        });
    } finally {
        await prisma.program.updateMany({
            where: { id: programId, shopifyStockLeaseToken: token },
            data: { shopifyStockLeaseUntil: null, shopifyStockLeaseToken: null },
        });
    }
    if (!settled) return { refused: "stale" };
    if (choice === "notLanded" && settled.variantId) {
        await nudgeProgramStock({ id: programId, shopifyVariantId: settled.variantId });
    }
    return { carry: settled.carry };
}

/**
 * Sets the program's base price on every Shopify variant it sells — the public
 * one and the hidden claimant one. Both carry the base (non-member) price; members
 * get their discount through {@link mintMemberDiscountCode}, so the member price
 * alone never reaches Shopify. Called from PATCH /api/programs/[id] when the
 * base price changes.
 *
 * A zero or null base is never pushed: a $0 public variant gives seats away in
 * the store. That case is reported to admins like any other failure.
 *
 * Never throws: on failure logs + emails admins via reportShopifyFailure and
 * returns false, so the caller can warn that Shopify's price is out of date.
 */
export async function syncProgramPrice(
    program: { id: number; name: string; shopifyVariantId?: string | null; claimantShopifyVariantId?: string | null },
    basePriceCents: number | null,
): Promise<boolean> {
    const variantIds = programVariantIds(program);
    if (variantIds.length === 0) return true;

    const context = { programId: program.id, variantIds, basePriceCents };
    const emailIntro = `The Shopify price for program <strong>${escapeHtml(program.name)}</strong> is out of date. Set it by hand in Shopify on every variant listed below.`;

    if (!basePriceCents || basePriceCents <= 0) {
        await reportShopifyFailure(
            "syncProgramPrice",
            new Error(`Base price is ${basePriceCents == null ? "unset" : "$0"}; Shopify variants ${variantIds.join(", ")} keep their old price`),
            context,
            emailIntro,
        );
        return false;
    }
    const price = (basePriceCents / 100).toFixed(2);

    // See createShopifySingleVariantProgram for why this branch exists (CHECKIN_ENV=local mock).
    if (config.shopifyMockActive()) {
        console.log(`[SHOPIFY] (mock) Would set price ${price} on variants: ${variantIds.join(", ")}`);
        return true;
    }

    const storeDomain = config.shopifyStoreDomain();
    const accessToken = await getAccessToken();
    if (!storeDomain || !accessToken) {
        await reportShopifyFailure(
            "syncProgramPrice",
            new Error("Shopify credentials missing or access token unavailable"),
            context,
            emailIntro,
        );
        return false;
    }

    try {
        // ponytail: REST product endpoints are legacy; switch to GraphQL productVariantsBulkUpdate with the capacity redesign's GraphQL move (≥2026-04).
        for (const variantId of variantIds) {
            const res = await shopifyFetch(`https://${storeDomain}/admin/api/${SHOPIFY_API_VERSION}/variants/${variantId}.json`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
                body: JSON.stringify({ variant: { id: Number(variantId), price } }),
            }, "Shopify update variant price");
            if (!res.ok) {
                throw new Error(`Shopify price update failed for variant ${variantId}: ${res.status} ${await res.text()}`);
            }
        }
        console.log(`[SHOPIFY] Set price ${price} on variants ${variantIds.join(", ")}`);
        return true;
    } catch (error) {
        console.error("[Shopify Error] Failed to update program price:", error);
        await reportShopifyFailure("syncProgramPrice", error, context, emailIntro);
        return false;
    }
}

/**
 * Sets a program's Shopify stock to an absolute quantity, for when relative
 * adjustments were skipped (a sale that ended and is re-armed). Same lease and
 * keyed-delta path as {@link adjustProgramInventory}: under the lease the carry
 * becomes `quantity − available`, replacing deltas owed before it, since the
 * caller computed `quantity` from the app's own seat count. Never throws.
 */
export async function setProgramInventory(
    program: { id: number; shopifyVariantId?: string | null },
    quantity: number,
    reason: string,
): Promise<boolean> {
    if (!program.shopifyVariantId) return true;
    if (config.shopifyMockActive()) console.log(`[SHOPIFY] (mock) Would set inventory to ${quantity} for variant: ${program.shopifyVariantId}`);
    return pushProgramStock(program.id, program.shopifyVariantId, reason, programStockTiming.requestCapMs, Number.NEGATIVE_INFINITY, quantity);
}

/**
 * Takes a program's store product off sale by setting its status to draft, so
 * neither the store page nor an old cart link can buy it. Idempotent. A program
 * without a product has nothing to take down and succeeds.
 *
 * Called by the sale sweep (lib/programs/saleSweep.ts) on the off-sale date for
 * programs that have a reserved-seat product. Nothing re-lists it automatically.
 *
 * Never throws: logs + emails the admin via reportShopifyFailure and returns
 * false, so the sweep retries on its next run.
 */
export async function setProgramProductOffSale(
    program: { shopifyProductId?: string | null },
): Promise<boolean> {
    const productId = program.shopifyProductId;
    if (!productId) return true;

    if (config.shopifyMockActive()) {
        console.log(`[SHOPIFY] (mock) Would set product ${productId} to draft`);
        return true;
    }

    const storeDomain = config.shopifyStoreDomain();
    const accessToken = await getAccessToken();
    if (!storeDomain || !accessToken) {
        await reportShopifyFailure(
            "setProgramProductOffSale",
            new Error("Shopify credentials missing or access token unavailable"),
            { shopifyProductId: productId },
            `Failed to take a program's Shopify product off sale after its off-sale date. It will be retried on the next daily run.`,
        );
        return false;
    }

    try {
        const res = await shopifyFetch(`https://${storeDomain}/admin/api/${SHOPIFY_API_VERSION}/products/${productId}.json`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'X-Shopify-Access-Token': accessToken,
            },
            body: JSON.stringify({ product: { id: Number(productId), status: 'draft' } }),
        }, "Shopify product off sale");
        if (!res.ok) {
            throw new Error(`Shopify product off-sale failed for ${productId}: ${res.status} ${await res.text()}`);
        }
        console.log(`[SHOPIFY] Product ${productId} set to draft (off sale)`);
        return true;
    } catch (error) {
        console.error("[Shopify Error] Failed to take program product off sale:", error);
        await reportShopifyFailure(
            "setProgramProductOffSale",
            error,
            { shopifyProductId: productId },
            `Failed to take a program's Shopify product off sale after its off-sale date. It will be retried on the next daily run.`,
        );
        return false;
    }
}

/**
 * Mints a server-side, single-use fixed-amount discount code for one
 * household's checkout. The code names the household it was minted for, and the
 * payment side refuses it on anyone else's order (unentitledMemberCodeUse). Single-pool programs ({@link Program.shopifyVariantId})
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
 * ponytail: one discount code per checkout — fine at Treehouse's
 * program-enrollment volume. Upgrade to the segment design above if that
 * stops being true.
 *
 * Never throws: a failure returns null so the caller falls back to an
 * undiscounted checkout link rather than blocking it (member pays full price
 * and can contact the board — better than a broken checkout).
 */
export async function mintMemberDiscountCode(
    programId: number,
    householdId: number,
    variantId: string,
    amountOffCents: number,
): Promise<string | null> {
    if (amountOffCents <= 0) return null;

    const code = `${householdMemberCodePrefix(programId, householdId)}${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

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
