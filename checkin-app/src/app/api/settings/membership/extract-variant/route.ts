import { formatCents } from "@checkin/money";
import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { apiError } from "@/lib/api-response";
import { fetchStorefrontProductVariants, ProductUrlError } from "@/lib/shopify/products";

export const dynamic = "force-dynamic";

/**
 * POST /api/settings/membership/extract-variant — resolve the Shopify variant
 * ID of the membership product from its storefront URL. Board members or
 * sysadmins only, same gate as the settings routes beside it.
 *
 * Body: { productUrl: string }. The URL is pinned hard before the server-side
 * fetch (fetchStorefrontProductVariants in lib/shopify/products.ts): https only, host
 * exactly SHOPIFY_STORE_DOMAIN, /products/<handle> path, no redirects.
 * Exactly one variant → { variantId } for the client to fill into the
 * variant-ID field (the normal settings save persists it). Several variants →
 * 409 listing "id — title — price" for each so the admin can pick manually.
 */
export const POST = withAuth({ roles: ["isSysadmin", "isBoardMember"] }, async (req, auth) => {
    if (auth.type !== "session") return apiError("Unauthorized", 401);
    let body: { productUrl?: string };
    try {
        body = await req.json();
    } catch {
        return apiError("Invalid JSON", 400);
    }
    const productUrl = body.productUrl?.trim();
    if (!productUrl) return apiError("productUrl is required", 400);

    try {
        const variants = await fetchStorefrontProductVariants(productUrl);
        if (variants.length === 0) return apiError("The product at that URL has no variants — check the link.", 400);
        if (variants.length > 1) {
            const listing = variants
                .map((v) => `${v.id} — ${v.title} — ${v.priceCents != null ? formatCents(v.priceCents) : "price unknown"}`)
                .join("; ");
            return apiError(`The product has ${variants.length} variants — paste the ID of the right one into the variant-ID field: ${listing}`, 409);
        }
        return NextResponse.json({ variantId: variants[0].id });
    } catch (err) {
        if (err instanceof ProductUrlError) return apiError(err.message, err.status);
        throw err;
    }
});
