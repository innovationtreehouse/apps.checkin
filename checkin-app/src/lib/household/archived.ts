import type { Prisma } from "@/generated/prisma/client";
import prisma from "@/lib/prisma";

/**
 * Run work that must see archived households. Row security hides them from
 * every other query. The opt-in is scoped to this transaction by SET LOCAL, so
 * it cannot leak onto a pooled connection.
 */
export function withArchivedHouseholds<T>(
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
    return prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL app.include_archived = 'on'`;
        return fn(tx);
    });
}
