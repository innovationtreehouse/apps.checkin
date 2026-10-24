// Shopify products: storefront variant lookup and program product creation.

import { escapeHtml } from "@/lib/email-templates/base";
import { config } from "@/lib/config";
import { getAccessToken, reportShopifyFailure, shopifyFetch, SHOPIFY_API_VERSION } from "@/lib/shopify/client";
import { outboundCall } from "@/security/outbound";

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

/** Stable Shopify handle for a program's product, so a retried sync finds what an earlier run created. */
export function programProductHandle(program: { id: number; name: string }, kind: "public" | "claimant"): string {
    const slug = program.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
    return `checkin-program-${program.id}-${slug}${kind === "claimant" ? "-reserved-seat" : ""}`;
}

/** The Program fields a product create sends, as outboundCall hands them back after stripping. */
type ProductCreateFields = { name: string; nonOrgMemberPriceCents: number; maxParticipants?: number | null };

/** The product already carrying `handle`, with its first variant; null when there is none. Throws on a failed lookup. */
async function findProductByHandle(
    storeDomain: string,
    accessToken: string,
    handle: string,
): Promise<{ productId: string; variantId: string } | null> {
    const res = await shopifyFetch(
        `https://${storeDomain}/admin/api/${SHOPIFY_API_VERSION}/products.json?handle=${encodeURIComponent(handle)}&fields=id,variants`,
        { method: 'GET', headers: { 'X-Shopify-Access-Token': accessToken } },
        "Shopify find product by handle",
    );
    if (!res.ok) throw new Error(`Shopify product lookup responded with status: ${res.status}`);
    const product = (await res.json()).products?.[0];
    if (!product) return null;
    const variantId = product.variants?.[0]?.id;
    if (!product.id || !variantId) throw new Error(`Shopify product ${product.id ?? "?"} for handle ${handle} has no variant`);
    return { productId: product.id.toString(), variantId: variantId.toString() };
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
 *
 * With a `handle`, a product already carrying it is returned instead of creating another.
 */
export async function createShopifySingleVariantProgram(
    name: string,
    basePriceCents: number | null,
    maxParticipants: number | null = null,
    handle?: string,
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
        // requires_shipping true) that a follow-up POST /variants.json collides
        // with (422 "The variant 'Default Title' already exists").
        const existing = handle ? await findProductByHandle(storeDomain, accessToken, handle) : null;
        if (existing) return { shopifyProductId: existing.productId, shopifyVariantId: existing.variantId };

        const productRes = await outboundCall(
            'shopify.product.create',
            { Program: { name, nonOrgMemberPriceCents: basePriceCents, maxParticipants } },
            (stripped) => {
                const program = stripped.Program as ProductCreateFields;
                return shopifyFetch(`https://${storeDomain}/admin/api/${SHOPIFY_API_VERSION}/products.json`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Shopify-Access-Token': accessToken,
                    },
                    body: JSON.stringify({
                        product: {
                            title: `${program.name} Program Enrollment`,
                            ...(handle && { handle }),
                            status: 'active',
                            product_type: "Educational Services",
                            variants: [{
                                price: (program.nonOrgMemberPriceCents / 100).toFixed(2),
                                requires_shipping: false,
                                inventory_management: program.maxParticipants ? 'shopify' : null,
                                inventory_policy: program.maxParticipants ? 'deny' : 'continue',
                            }],
                        }
                    })
                }, "Shopify create product");
            },
        );

        if (!productRes.ok) {
            const errorData = await productRes.text();
            console.error(`[Shopify API Error] ${productRes.status} ${productRes.statusText}`, errorData);
            throw new Error(`Shopify API responded with status: ${productRes.status}`);
        }

        const productData = await productRes.json();
        productId = productData.product.id;

        // Without the variant id the program can never match a webhook line-item, so a
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
 * With a `handle`, a product already carrying it is unlisted and returned instead
 * of creating another.
 */
export async function createClaimantProduct(
    name: string,
    basePriceCents: number | null,
    handle?: string,
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
        const existing = handle ? await findProductByHandle(storeDomain, accessToken, handle) : null;
        let variantId = existing?.variantId;
        productId = existing?.productId ?? null;
        if (!existing) {
            const productRes = await outboundCall(
                'shopify.product.create',
                { Program: { name, nonOrgMemberPriceCents: basePriceCents } },
                (stripped) => {
                    const program = stripped.Program as ProductCreateFields;
                    return shopifyFetch(`https://${storeDomain}/admin/api/${SHOPIFY_API_VERSION}/products.json`, {
                        method: 'POST',
                        headers,
                        body: JSON.stringify({
                            product: {
                                title: `${program.name} Program Enrollment (reserved seat)`,
                                ...(handle && { handle }),
                                status: 'draft',
                                published: true,
                                product_type: "Educational Services",
                                variants: [{
                                    price: (program.nonOrgMemberPriceCents / 100).toFixed(2),
                                    requires_shipping: false,
                                    inventory_management: null,
                                    inventory_policy: 'continue',
                                }],
                            },
                        }),
                    }, "Shopify create claimant product");
                },
            );
            if (!productRes.ok) {
                throw new Error(`Shopify API responded with status: ${productRes.status} ${await productRes.text()}`);
            }
            const product = (await productRes.json()).product;
            productId = product?.id?.toString() ?? null;
            variantId = product?.variants?.[0]?.id?.toString();
        }
        if (!productId || !variantId) throw new Error("Shopify claimant product response is missing the product or variant id");

        const mutation = `
            mutation UnlistClaimantProduct($product: ProductUpdateInput!) {
                productUpdate(product: $product) {
                    product { id status }
                    userErrors { field message }
                }
            }`;
        const res = await outboundCall(
            'shopify.product.update',
            { Program: { claimantShopifyProductId: productId } },
            (stripped) => {
                const program = stripped.Program as { claimantShopifyProductId: string };
                return shopifyFetch(`https://${storeDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({
                        query: mutation,
                        variables: { product: { id: `gid://shopify/Product/${program.claimantShopifyProductId}`, status: 'UNLISTED' } },
                    }),
                }, "Shopify unlist claimant product");
            },
        );
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
