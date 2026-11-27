import prisma from "@/lib/prisma";
import { IN_LIVE_HOUSEHOLD } from "@/lib/household/archived";
import { coveredThrough, membershipYearCycle } from "@/lib/membership/renewal";
import { settledThisCycleWhere } from "@/lib/membership/lifecycle";

export interface CurrentMember {
    email: string;
    name: string | null;
    /** The day the household's coverage ends; null when the board has set no year boundary. */
    validThrough: Date | null;
}

/**
 * Everyone with an email in a live household whose ACTIVE membership still covers
 * `now`. Reads the boundary and each household's settled process in one query,
 * applying the same coveredThrough rule as membershipValidThrough. No boundary set
 * falls back to status-only, as coversThrough does.
 */
export async function listCurrentMembers(now = new Date()): Promise<CurrentMember[]> {
    const settings = await prisma.boardSettings.findUnique({ where: { id: 1 }, select: { orgMembershipYearBoundary: true } });
    const cycle = settings?.orgMembershipYearBoundary ? membershipYearCycle(settings.orgMembershipYearBoundary, now) : null;
    const people = await prisma.person.findMany({
        where: {
            AND: [IN_LIVE_HOUSEHOLD, { household: { orgMembership: { status: "ACTIVE" } } }],
            email: { not: null },
        },
        select: {
            email: true,
            name: true,
            household: {
                select: {
                    orgMembership: {
                        select: {
                            processes: {
                                where: settledThisCycleWhere(cycle?.cycleStart.getUTCFullYear() ?? null),
                                select: { id: true },
                                take: 1,
                            },
                        },
                    },
                },
            },
        },
        orderBy: { email: "asc" },
    });

    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const members: CurrentMember[] = [];
    for (const p of people) {
        if (!p.email) continue;
        const settled = (p.household.orgMembership?.processes.length ?? 0) > 0;
        const validThrough = cycle ? coveredThrough(cycle, settled) : null;
        if (validThrough && validThrough.getTime() < today) continue;
        members.push({ email: p.email, name: p.name, validThrough });
    }
    return members;
}

// A leading = + - @ (or tab/CR) makes a spreadsheet read the cell as a formula.
function cell(value: string): string {
    const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
    return `"${safe.replace(/"/g, '""')}"`;
}

export function membersToCsv(members: CurrentMember[]): string {
    const rows = members.map((m) =>
        [m.email, m.name ?? "", m.validThrough?.toISOString().slice(0, 10) ?? ""].map(cell).join(","),
    );
    return ["email,name,validThrough", ...rows].join("\r\n") + "\r\n";
}
