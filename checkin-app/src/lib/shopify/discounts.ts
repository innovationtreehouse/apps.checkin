// Shopify discount codes: the per-checkout member discount minter.

import crypto from "crypto";
import { logIntegrationError } from "@/lib/logger";
import { config } from "@/lib/config";
import { householdMemberCodePrefix } from "@/lib/programs/memberDiscountCode";
import { checkoutVariantId } from "@/lib/programs/variants";
import { getAccessToken, shopifyFetch, SHOPIFY_API_VERSION } from "@/lib/shopify/client";
import { outboundCall } from "@/security/outbound";

/** The Program fields a mint sends, as outboundCall hands them back after stripping. */
type DiscountProgramFields = { id: number; shopifyVariantId?: string | null; claimantShopifyVariantId?: string | null };

/**
 * Mints a server-side, single-use fixed-amount discount code for one
 * household's checkout. The code names the household it was minted for, and the
 * payment side refuses it on anyone else's order (unentitledMemberCodeUse). Single-pool programs ({@link Program.shopifyVariantId})
 * sell at the base/non-member price; an ACTIVE org member gets this code
 * appended to their cart link (`?discount=<code>`) to bring the price down to
 * the member rate. Interim mechanism —
 * docs/in-design/SHOPIFY_MEMBER_SEGMENT_PRICING.md's segment-gated automatic
 * discount (its §5) is the planned upgrade once checkout identity is solved;
 * this mints one real Shopify object per checkout in the meantime.
 *
 * Implemented via GraphQL `discountCodeBasicCreate` (scope: write_discounts).
 * NOT the legacy REST price_rules API: that needs the separate
 * write_price_rules scope that neither store's app grants, and Shopify has
 * deprecated it anyway.
 * `appliesOnEachItem: true` carries the load-bearing 'each' semantics: a
 * member household enrolling N kids buys quantity N of the variant and every
 * seat gets the member price (amount-off-once would overcharge N-1 seats).
 *
 * ponytail: one discount code per checkout — fine at Treehouse's
 * program-enrollment volume. Upgrade to the segment design above if that
 * stops being true.
 *
 * The code applies to the program's checkout variant ({@link checkoutVariantId}).
 *
 * Never throws: a failure returns null so the caller falls back to an
 * undiscounted checkout link rather than blocking it (member pays full price
 * and can contact the board — better than a broken checkout).
 */
export async function mintMemberDiscountCode(
    program: DiscountProgramFields,
    householdId: number,
    amountOffCents: number,
): Promise<string | null> {
    const programId = program.id;
    const variantId = checkoutVariantId(program);
    if (amountOffCents <= 0 || !variantId) return null;

    const suffix = crypto.randomBytes(4).toString('hex').toUpperCase();
    const code = `${householdMemberCodePrefix(programId, householdId)}${suffix}`;

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
        const bag = {
            Program: { id: programId, shopifyVariantId: program.shopifyVariantId, claimantShopifyVariantId: program.claimantShopifyVariantId },
            Household: { id: householdId },
        };
        const res = await outboundCall('shopify.discount.create', bag, (stripped) => {
            const sentProgram = stripped.Program as DiscountProgramFields;
            const sentCode = `${householdMemberCodePrefix(sentProgram.id, (stripped.Household as { id: number }).id)}${suffix}`;
            return shopifyFetch(`https://${storeDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Shopify-Access-Token': accessToken,
                },
                body: JSON.stringify({
                    query: mutation,
                    variables: {
                        discount: {
                            title: sentCode,
                            code: sentCode,
                            startsAt: startsAt.toISOString(),
                            endsAt: endsAt.toISOString(),
                            usageLimit: 1,
                            appliesOncePerCustomer: true,
                            customerSelection: { all: true },
                            customerGets: {
                                // appliesOnEachItem: the 'each' semantics (see doc comment).
                                value: { discountAmount: { amount: (amountOffCents / 100).toFixed(2), appliesOnEachItem: true } },
                                items: { products: { productVariantsToAdd: [`gid://shopify/ProductVariant/${checkoutVariantId(sentProgram)}`] } },
                            },
                        },
                    },
                }),
            }, "Shopify mint member discount");
        });
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
