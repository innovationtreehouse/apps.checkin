import { staleJobOf } from "@/lib/opsIncidents";
import prisma from "@/lib/prisma";

/** An incident not yet closed, as System Status lists it. "watching" until its first notice goes out, then "open". */
export interface ActiveIncident {
    key: string;
    status: "watching" | "open";
    kind: string;
    cause: string;
    lanes: string[];
    firstSeenAt: Date;
    runsSeen: number;
    itemsAffected: number;
}

/** Incidents not yet closed, oldest first. */
export async function getActiveIncidents(): Promise<ActiveIncident[]> {
    const rows = await prisma.opsIncident.findMany({
        where: { closedAt: null },
        orderBy: { firstSeenAt: "asc" },
        select: { key: true, kind: true, cause: true, lanes: true, firstSeenAt: true, runsSeen: true, itemsAffected: true, notifiedAt: true },
    });
    return rows.map(({ notifiedAt, ...row }) => ({ ...row, status: notifiedAt ? "open" : "watching" }));
}

/** Open incidents, and the jobs whose stopped-job incident is open, so the badge counts that outage once. */
export async function openIncidentSummary(): Promise<{ openIncidents: number; staleJobs: Set<string> }> {
    const open = await prisma.opsIncident.findMany({ where: { closedAt: null, notifiedAt: { not: null } }, select: { key: true } });
    const staleJobs = new Set(open.flatMap(({ key }) => staleJobOf(key) ?? []));
    return { openIncidents: open.length, staleJobs };
}
