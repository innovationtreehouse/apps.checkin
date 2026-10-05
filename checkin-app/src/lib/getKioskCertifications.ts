import prisma from "@/lib/prisma";
import { LIVE_PERSON } from "@/lib/person/filters";
import { invalidatableCache } from "@/lib/invalidatableCache";

/**
 * Tool-cert grid payload for GET /api/kioskdisplay/certifications.
 *
 * Same per-process cache as getFullAttendance (see {@link invalidatableCache}).
 * The present-limited grid also refreshes every 60s while anyone is present;
 * the all-members grid has no occupancy signal and refreshes only on
 * invalidation. Visit writes go through invalidateAttendanceCache (which also
 * clears this, because the present-limited grid is occupancy). Cert/tool
 * writes call invalidateKioskCertificationsCache directly.
 */
type CertsPayload = {
    participants: {
        id: number;
        name: string;
        nickname: string | null;
        toolStatuses: { toolId: number; level: string }[];
    }[];
    tools: { id: number; name: string }[];
};

const presentCache = invalidatableCache(() => computeKioskCertifications(true), (p) => p.participants.length > 0);
const allCache = invalidatableCache(() => computeKioskCertifications(false), () => false);

export function invalidateKioskCertificationsCache(): void {
    presentCache.invalidate();
    allCache.invalidate();
}

export async function getKioskCertifications(opts: { limitToPresent?: boolean } = {}): Promise<CertsPayload> {
    return (opts.limitToPresent !== false ? presentCache : allCache).get();
}

async function computeKioskCertifications(limitToPresent: boolean): Promise<CertsPayload> {
    const personSelect = {
        id: true,
        email: true,
        name: true,
        nickname: true,
        toolStatuses: { select: { toolId: true, level: true } },
    } as const;

    let participantsData: {
        id: number;
        email: string | null;
        name: string | null;
        nickname: string | null;
        toolStatuses: { toolId: number; level: string }[];
    }[];

    if (limitToPresent) {
        const activeVisits = await prisma.visit.findMany({
            where: { departedAt: null, deletedAt: null, person: LIVE_PERSON },
            include: { person: { select: personSelect } },
            orderBy: { arrivedAt: "desc" },
        });
        participantsData = activeVisits.map(v => v.person);
    } else {
        participantsData = await prisma.person.findMany({
            where: LIVE_PERSON,
            select: personSelect,
        });
    }

    const participants = participantsData.map((participant) => ({
        id: participant.id,
        name: participant.name?.trim() || participant.email?.split("@")[0] || "",
        nickname: participant.nickname,
        toolStatuses: participant.toolStatuses,
    }));

    const tools = await prisma.tool.findMany({
        orderBy: { name: "asc" },
        select: { id: true, name: true },
    });

    return { participants, tools };
}
