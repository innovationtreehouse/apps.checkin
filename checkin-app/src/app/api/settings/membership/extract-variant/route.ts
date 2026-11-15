import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { apiError } from "@/lib/api-response";
import { lookupProductVariantsByUrl, ProductUrlError } from "@/lib/shopify/products";

export const dynamic = "force-dynamic";

/**
 * POST /api/settings/membership/extract-variant — list the Shopify variants of
 * the membership product at a storefront URL. Board members or sysadmins only,
 * same gate as the settings routes beside it.
 *
 * Body: { productUrl: string }. Only the /products/<handle> part of the URL is
 * used: lookupProductVariantsByUrl (lib/shopify/products.ts) reads that handle
 * from the Shopify Admin API on the configured store domain.
 * Answers { productTitle, variants: [{ id, title, priceCents }] } so the page
 * can show the product for the Board to confirm, or let it pick one of several
 * variants. Nothing is persisted; the normal settings save does that.
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
        const product = await lookupProductVariantsByUrl(productUrl);
        if (product.variants.length === 0) return apiError("The product at that URL has no variants — check the link.", 400);
        return NextResponse.json(product);
    } catch (err) {
        if (err instanceof ProductUrlError) return apiError(err.message, err.status);
        throw err;
    }
});
