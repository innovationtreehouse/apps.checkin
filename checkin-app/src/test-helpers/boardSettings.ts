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

/**
 * Set the membership-year boundary to 1 September, which program writes need.
 * Returns the restore from snapshotBoardSettings.
 */
export async function setMembershipYearBoundary(): Promise<() => Promise<void>> {
    const restore = await snapshotBoardSettings();
    const boundary = new Date('2000-09-01T00:00:00Z');
    await prisma.boardSettings.upsert({
        where: { id: 1 },
        create: { id: 1, orgMembershipYearBoundary: boundary },
        update: { orgMembershipYearBoundary: boundary },
    });
    return restore;
}

/**
 * Set a background-check validity policy (a membership-year boundary and a recheck
 * window), so a check stamped today counts as valid and a household with a cleared
 * lead qualifies. Returns the restore from snapshotBoardSettings.
 */
export async function setBgRecheckPolicy(): Promise<() => Promise<void>> {
    const restore = await snapshotBoardSettings();
    const data = { orgMembershipYearBoundary: new Date('2000-09-01T00:00:00Z'), bgRecheckMonths: 29 };
    await prisma.boardSettings.upsert({ where: { id: 1 }, create: { id: 1, ...data }, update: data });
    return restore;
}
