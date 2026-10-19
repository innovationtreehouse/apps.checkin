import prisma from "@/lib/prisma";
import { adjustProgramInventory, type StockWriteOptions } from "@/lib/shopify/stock";
import type { TxClient } from "@/lib/db-client";

/**
 * A `changeProgramStockWith` stand-in for tests that mock `@/lib/shopify`: runs
 * the change on the test's prisma client and hands a non-zero delta to the
 * mocked `adjustProgramInventory`, so stock assertions stay on that one mock.
 */
export async function forwardStockWith<T>(
    program: { id: number; shopifyVariantId?: string | null },
    reason: string,
    change: (tx: TxClient) => Promise<{ result: T; delta: number }>,
    options?: StockWriteOptions,
): Promise<{ result: T; landed: boolean }> {
    const { result, delta } = await change(prisma);
    if (delta === 0) return { result, landed: true };
    const landed = await (options ? adjustProgramInventory(program, delta, reason, options) : adjustProgramInventory(program, delta, reason));
    return { result, landed: landed !== false };
}
