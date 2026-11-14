// Shopify products: variant lookup by product URL and program product creation.

import { centsToDecimalString, dollarsToCentsOrNull } from "@checkin/money";
import { config } from "@/lib/config";
import { logIntegrationError } from "@/lib/logger";
import { getAccessToken, reportShopifyFailure, shopifyFetch, SHOPIFY_API_VERSION } from "@/lib/shopify/client";
import { outboundCall } from "@/security/outbound";

/** Thrown by lookupProductVariantsByUrl; status maps straight onto the API response. */
export class ProductUrlError extends Error {
    constructor(message: string, public readonly status: number) {
        super(message);
        this.name = "ProductUrlError";
    }
}

export interface StorefrontVariant {
    id: string;
    title: string;
    /** null when Shopify's price is missing or not a decimal amount. */
    priceCents: number | null;
}

/** A product as the Admin REST products.json returns it with `fields=id,title,variants`. */
interface AdminProduct {
    id?: number | string;
    title?: string;
    variants?: Array<{ id?: number | string; title?: string; price?: unknown }>;
}

/** A non-OK Admin API answer, keeping its status for the caller. */
class ShopifyStatusError extends Error {
    constructor(public readonly status: number) {
        super(`Shopify product lookup responded with status: ${status}`);
        this.name = "ShopifyStatusError";
    }
}

/** The Admin API product carrying `handle`; null when there is none. Throws on a failed lookup. */
async function getProductByHandle(storeDomain: string, accessToken: string, handle: string): Promise<AdminProduct | null> {
    const res = await shopifyFetch(
        `https://${storeDomain}/admin/api/${SHOPIFY_API_VERSION}/products.json?handle=${encodeURIComponent(handle)}&fields=id,title,variants`,
        { method: "GET", headers: { "X-Shopify-Access-Token": accessToken } },
        "Shopify find product by handle",
    );
    if (!res.ok) throw new ShopifyStatusError(res.status);
    const body: { products?: AdminProduct[] } = await res.json();
    return body.products?.[0] ?? null;
}

/**
 * Resolve the variants of a membership product from a pasted storefront URL,
 * read through the Shopify Admin API.
 * Backs the "Extract variant from URL" action in membership settings: for a
 * single-variant product the Shopify admin UI hides the lone "Default Title"
 * variant entirely, so the product ID is the only number an admin can see —
 * and pasting THAT into the variant-ID field 410s the cart permalink checkout
 * (lib/membership/payment.ts builds https://<store>/cart/<variantId>:1).
 *
 * Only the `<handle>` is taken from the pasted URL (https, /products/<handle>,
 * query/hash/trailing slash ignored); the product is read by that handle from
 * the Admin API on the configured SHOPIFY_STORE_DOMAIN. The pasted host never
 * picks the request target, so any host is accepted — the store's custom
 * domain as well as its myshopify.com domain.
 */
export async function lookupProductVariantsByUrl(productUrl: string): Promise<{ productTitle: string; variants: StorefrontVariant[] }> {
    let parsed: URL;
    try {
        parsed = new URL(productUrl.trim());
    } catch {
        throw new ProductUrlError("That is not a valid URL.", 400);
    }
    if (parsed.protocol !== "https:") throw new ProductUrlError("The product URL must start with https://.", 400);
    const handle = /^\/products\/([a-z0-9-]+)$/.exec(parsed.pathname.replace(/\/+$/, ""))?.[1];
    if (!handle) throw new ProductUrlError("The URL must be a product page: https://<store>/products/<product-handle>.", 400);

    const storeDomain = config.shopifyStoreDomain();
    if (!storeDomain || !config.shopifyClientId() || !config.shopifyClientSecret()) {
        throw new ProductUrlError("Shopify is not configured on this instance, so the product cannot be looked up.", 400);
    }
    const accessToken = await getAccessToken();
    if (!accessToken) {
        await logIntegrationError("shopify", new Error("No Shopify access token could be obtained"), { operation: "lookupProductVariantsByUrl", handle });
        throw new ProductUrlError("Could not sign in to Shopify — check the Shopify app credentials, then try again.", 502);
    }

    let product: AdminProduct | null;
    try {
        product = await getProductByHandle(storeDomain, accessToken, handle);
    } catch (err) {
        await logIntegrationError("shopify", err, { operation: "lookupProductVariantsByUrl", handle });
        if (err instanceof ShopifyStatusError && err.status === 429) {
            throw new ProductUrlError("Shopify is rate-limiting requests right now — try again in a minute.", 429);
        }
        throw new ProductUrlError("Could not read the product from Shopify — try again in a minute.", 502);
    }
    if (!product) throw new ProductUrlError(`Shopify has no product with the handle "${handle}" — check the link.`, 404);

    const variants = (product.variants ?? [])
        .filter((v) => v?.id !== undefined && v?.id !== null)
        .map((v) => ({
            id: String(v.id),
            title: v.title || "Default Title",
            priceCents: typeof v.price === "string" || typeof v.price === "number" ? dollarsToCentsOrNull(String(v.price)) : null,
        }));
    return { productTitle: product.title || handle, variants };
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
    const product = await getProductByHandle(storeDomain, accessToken, handle);
    if (!product) return null;
    const variantId = product.variants?.[0]?.id;
    if (!product.id || !variantId) throw new Error(`Shopify product ${product.id ?? "?"} for handle ${handle} has no variant`);
    return { productId: product.id.toString(), variantId: variantId.toString() };
}

/**
 * Single-pool model: mints ONE Shopify variant
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
            `Program ${name} is priced, but its Shopify product was not created because Shopify is not configured. Its payment link will not work until a board member runs Sync to Shopify.`,
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
                                price: centsToDecimalString(program.nonOrgMemberPriceCents),
                                requires_shipping: false,
                                inventory_management: program.maxParticipants != null ? 'shopify' : null,
                                inventory_policy: program.maxParticipants != null ? 'deny' : 'continue',
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
            `An error occurred in the Shopify integration while creating the variant for program: ${name}.`,
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
                                    price: centsToDecimalString(program.nonOrgMemberPriceCents),
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
            `An error occurred in the Shopify integration while creating the reserved-seat product for program: ${name}.`,
        );
        return null;
    }
}
