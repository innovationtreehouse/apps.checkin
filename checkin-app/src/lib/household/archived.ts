import type { Prisma } from "@/generated/prisma/client";
import prisma from "@/lib/prisma";

/**
 * A person whose household is not archived. Row security hides an archived
 * household only from queries that reach Household, so a person query that
 * never joins it spreads this in to drop the household's members.
 */
export const IN_LIVE_HOUSEHOLD = { household: { archivedAt: null } } satisfies Prisma.PersonWhereInput;

/** Whether the household is live: false when it is archived or does not exist. */
export async function isLiveHousehold(id: number): Promise<boolean> {
    return (await prisma.household.count({ where: { id, archivedAt: null } })) > 0;
}

/**
 * A household and its membership, archived or not. A sign-in still reads an
 * archived household's membership, so a DENIED one stays locked out.
 */
export function householdWithMembership(id: number) {
    return withArchivedHouseholds((tx) =>
        tx.household.findUniqueOrThrow({ where: { id }, include: { orgMembership: true } }),
    );
}

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
