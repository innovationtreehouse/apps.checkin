import prisma from "@/lib/prisma";

// ponytail: per-process, like kioskSeen and the attendance cache. One ECS task today.
const running = new Set<Date>();

/** Runs the nightly job. Its close is not reported until the job has ended, so a reply naming it never lists people the job has yet to depart. */
export async function duringNightlyRun<T>(run: () => Promise<T>): Promise<T> {
    const startedAt = new Date();
    running.add(startedAt);
    try {
        return await run();
    } finally {
        running.delete(startedAt);
    }
}

/**
 * The latest finished nightly close, as an ISO timestamp, or null if none. A
 * reply that also carries a roster reads this first: a roster read afterwards
 * reflects every departure of the close it names.
 */
export async function lastNightlyCloseAt(): Promise<string | null> {
    // Overlapping runs: only a close from before the earliest one has certainly finished.
    const [earliestRun] = [...running];
    const close = await prisma.facilityClose.findFirst({
        where: { via: "NIGHTLY_SWEEP", ...(earliestRun ? { closedAt: { lt: earliestRun } } : {}) },
        orderBy: { closedAt: "desc" },
        select: { closedAt: true },
    });
    return close?.closedAt.toISOString() ?? null;
}
