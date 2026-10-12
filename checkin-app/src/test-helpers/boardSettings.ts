import prisma from '@/lib/prisma';

/**
 * Snapshot the BoardSettings singleton. The returned function puts the whole row
 * back, or deletes it when it did not exist, so no setting leaks to later suites
 * sharing the integration DB.
 */
export async function snapshotBoardSettings(): Promise<() => Promise<void>> {
    const prev = await prisma.boardSettings.findUnique({ where: { id: 1 } });
    return async () => {
        if (prev) await prisma.boardSettings.update({ where: { id: 1 }, data: prev });
        else await prisma.boardSettings.deleteMany({ where: { id: 1 } });
    };
}
