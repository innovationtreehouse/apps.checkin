import prisma from "@/lib/prisma";

// ponytail: per-process, like kioskSeen and the attendance cache. One ECS task today.
let runStartedAt: Date | null = null;

/** Runs the nightly job. Its close is not reported until the job has ended, so a reply naming it never lists people the job has yet to depart. */
export async function duringNightlyRun<T>(run: () => Promise<T>): Promise<T> {
    runStartedAt = new Date();
    try {
        return await run();
    } finally {
        runStartedAt = null;
    }
}

/**
 * The latest finished nightly close, as an ISO timestamp, or null if none. A
 * reply that also carries a roster reads this first: a roster read afterwards
 * reflects every departure of the close it names.
 */
export async function lastNightlyCloseAt(): Promise<string | null> {
    const close = await prisma.facilityClose.findFirst({
        where: { via: "NIGHTLY_SWEEP", ...(runStartedAt ? { closedAt: { lt: runStartedAt } } : {}) },
        orderBy: { closedAt: "desc" },
        select: { closedAt: true },
    });
    return close?.closedAt.toISOString() ?? null;
}
