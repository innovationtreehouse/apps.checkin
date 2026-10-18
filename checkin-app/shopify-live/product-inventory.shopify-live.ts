/**
 * @jest-environment node
 */
/**
 * LIVE contract: single-pool product creation + the locked compare-and-set stock writer,
 * exercised through the app's real lib functions against the real dev store.
 * These are the exact call sequences the capacity model (#930,
 * docs/architecture/PROGRAM_CAPACITY_AND_SCHOLARSHIPS.md) depends on.
 */
// The lib's failure path reports through prisma + email — keep the live suite
// DB- and mail-free (a live failure should fail the test, not email the board).
// The stock writer's bookkeeping gets one in-memory Program row (increment / lease-token semantics).
jest.mock("@/lib/prisma", () => {
    const row: Record<string, unknown> = {
        shopifyStockCarry: 0, shopifyStockPendingWrite: null, shopifyStockPushNeededAt: null, shopifyStockUnconfirmed: 0,
        shopifyStockLeaseUntil: null, shopifyStockLeaseToken: null, startAt: new Date("2099-01-01"), offSaleAt: null, saleEndedAt: null,
    };
    const apply = (data: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(data)) {
            row[k] = v !== null && typeof v === "object" && "increment" in v ? (row[k] as number) + (v as { increment: number }).increment : v;
        }
    };
    return {
        __esModule: true,
        default: {
            program: {
                update: async ({ data }: { data: Record<string, unknown> }) => { apply(data); return { ...row }; },
                updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
                    if ("shopifyStockLeaseToken" in where && where.shopifyStockLeaseToken !== row.shopifyStockLeaseToken) return { count: 0 };
                    if (where.OR && row.shopifyStockLeaseUntil instanceof Date && row.shopifyStockLeaseUntil > new Date()) return { count: 0 };
                    apply(data);
                    return { count: 1 };
                },
                findUnique: async () => ({ ...row }),
            },
            person: { findMany: async () => [] },
        },
    };
});
jest.mock("@/lib/email", () => ({ sendEmail: jest.fn() }));

import { createShopifySingleVariantProgram, adjustProgramInventory } from "@/lib/shopify";
import {
    ensureLiveStore,
    testRunName,
    trackProduct,
    cleanupTracked,
    getVariant,
    getAvailable,
} from "./helpers";

const MAX_PARTICIPANTS = 5;

describe("live: single-pool product + inventory contract", () => {
    let productId: string;
    let variantId: string;

    beforeAll(() => {
        ensureLiveStore();
    });

    afterAll(async () => {
        await cleanupTracked();
    });

    it("createShopifySingleVariantProgram creates an active product with a managed, deny-policy variant", async () => {
        const created = await createShopifySingleVariantProgram(testRunName("prodinv"), 2500, MAX_PARTICIPANTS);
        expect(created).not.toBeNull();
        productId = created!.shopifyProductId;
        variantId = created!.shopifyVariantId;
        trackProduct(productId);

        const variant = await getVariant(variantId);
        expect(String(variant.product_id)).toBe(productId);
        expect(variant.price).toBe("25.00");
        // The capacity model's load-bearing settings: Shopify tracks the count
        // and REFUSES oversell (policy deny) — see #930.
        expect(variant.inventory_management).toBe("shopify");
        expect(variant.inventory_policy).toBe("deny");
    });

    it("adjustProgramInventory activates the fresh item and seeds initial inventory to maxParticipants", async () => {
        expect(await adjustProgramInventory({ id: 0, shopifyVariantId: variantId }, MAX_PARTICIPANTS, "initial-stock")).toBe(true);
        const variant = await getVariant(variantId);
        expect(await getAvailable(variant.inventory_item_id)).toBe(MAX_PARTICIPANTS);
    });

    it("adjustProgramInventory applies deltas (scholarship hold -1, release +1)", async () => {
        const program = { id: 0, shopifyVariantId: variantId };
        const variant = await getVariant(variantId);

        expect(await adjustProgramInventory(program, -1, "scholarship-hold")).toBe(true);
        expect(await getAvailable(variant.inventory_item_id)).toBe(MAX_PARTICIPANTS - 1);

        expect(await adjustProgramInventory(program, +1, "hold-release")).toBe(true);
        expect(await getAvailable(variant.inventory_item_id)).toBe(MAX_PARTICIPANTS);
    });

    it("free programs (no price) create nothing", async () => {
        expect(await createShopifySingleVariantProgram(testRunName("free"), null, 5)).toBeNull();
        expect(await createShopifySingleVariantProgram(testRunName("zero"), 0, 5)).toBeNull();
    });
});
