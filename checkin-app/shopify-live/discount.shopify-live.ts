/**
 * @jest-environment node
 */
/**
 * LIVE contract: the member discount minted for single-pool member checkout
 * (GraphQL discountCodeBasicCreate; scope write_discounts — the 2026-07-14
 * root cause: the legacy REST price_rules mint needed a scope no store app
 * grants). The per-unit pricing of multi-child household carts hangs entirely
 * on appliesOnEachItem semantics (REST's 'each'; see the #930 review) — this
 * pins the discount configuration Shopify actually stores, not what we think
 * we sent.
 */
jest.mock("@/lib/prisma", () => ({ __esModule: true, default: {} }));
jest.mock("@/lib/email", () => ({ sendEmail: jest.fn() }));

import { createShopifySingleVariantProgram } from "@/lib/shopify/products";
import { mintMemberDiscountCode } from "@/lib/shopify/discounts";
import { CITEST_PROGRAM_ID_BASE } from "./guard";
import {
    ensureLiveStore,
    testRunName,
    trackProduct,
    trackDiscount,
    cleanupTracked,
    findDiscountByCode,
} from "./helpers";

describe("live: member discount price-rule contract", () => {
    let variantId: string;

    beforeAll(async () => {
        ensureLiveStore();
        const created = await createShopifySingleVariantProgram(testRunName("discount"), 5000, 3);
        expect(created).not.toBeNull();
        trackProduct(created!.shopifyProductId);
        variantId = created!.shopifyVariantId;
    });

    afterAll(async () => {
        await cleanupTracked();
    });

    it("mints a code whose stored discount is fixed-amount, per-unit, scoped to the variant, single-use", async () => {
        // programId from the janitor-recognizable reserved range (PRG9999999xx-…).
        const code = await mintMemberDiscountCode(CITEST_PROGRAM_ID_BASE + 1, 1, variantId, 1000);
        expect(code).toMatch(new RegExp(`^PRG${CITEST_PROGRAM_ID_BASE + 1}-H1-[0-9A-F]{8}$`));

        const discount = await findDiscountByCode(code!);
        expect(discount).not.toBeNull();
        trackDiscount(discount!.id);

        // The load-bearing semantics for multi-child member carts (variant:N):
        // appliesOnEachItem takes the amount off EVERY unit; amount-off-once
        // would subtract it once from the whole line (the overcharge bug class).
        expect(discount!.title).toBe(code);
        expect(parseFloat(discount!.amount)).toBe(10);
        expect(discount!.appliesOnEachItem).toBe(true);
        expect(discount!.variantGids).toEqual([`gid://shopify/ProductVariant/${variantId}`]);
        expect(discount!.usageLimit).toBe(1);
        expect(discount!.appliesOncePerCustomer).toBe(true);
        // ~48h validity window per design.
        const windowMs = new Date(discount!.endsAt!).getTime() - new Date(discount!.startsAt).getTime();
        expect(windowMs).toBeGreaterThan(47 * 60 * 60 * 1000);
        expect(windowMs).toBeLessThan(49 * 60 * 60 * 1000);
    });

    it("returns null (no discount) for a zero discount", async () => {
        expect(await mintMemberDiscountCode(CITEST_PROGRAM_ID_BASE + 2, 1, variantId, 0)).toBeNull();
    });
});
