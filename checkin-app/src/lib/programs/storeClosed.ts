import prisma from "@/lib/prisma";
import type { TxClient } from "@/lib/db-client";

/** Whether the Board has closed the store to program seats (BoardSettings.programStoreClosedAt), so seats are claimed in the app only. */
export async function isProgramStoreClosed(db: TxClient = prisma): Promise<boolean> {
    const settings = await db.boardSettings.findUnique({ where: { id: 1 }, select: { programStoreClosedAt: true } });
    return !!settings?.programStoreClosedAt;
}
