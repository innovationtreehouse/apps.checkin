import type { PersonRoleKind } from "@/generated/prisma/client";
import type { DbClient } from "@/lib/db-client";
import { bgFreshThreshold } from "@/lib/membership/personBgCheck";
import { liveMembershipYear } from "@/lib/programYear";
import { calculateAge } from "@/lib/time";

/** A position that needs a current background check: six program and bucket kinds, plus every role. */
export type PositionKind = "VOLUNTEER" | "CORE_VOLUNTEER" | "PROGRAM_LEADER" | "RUN_LEADER" | "BUCKET_OWNER" | "BUCKET_TREASURER" | PersonRoleKind;

export type Position = { kind: PositionKind; label: string; year: number };

/** CURRENT: the check is valid at the start of the year served. NOT_CURRENT: it is older. NO_CHECK: none on record. */
export type PositionCheckStanding = "CURRENT" | "NOT_CURRENT" | "NO_CHECK";

export type PositionHolderRow = {
    personId: number;
    name: string;
    householdId: number;
    positions: Position[];
    /** The latest year among their positions, the one their check is judged against. */
    year: number;
    lastBackgroundCheck: string | null;
    standing: PositionCheckStanding;
};

const ROLE_LABEL: Record<PersonRoleKind, string> = {
    SYSADMIN: "Sysadmin",
    BOARD: "Board",
    KEYHOLDER: "Keyholder",
    BG_REVIEWER: "Background-check reviewer",
    OPERATIONS: "Operations",
    INVENTORY_MANAGER: "Inventory manager",
    FINANCE: "Finance",
    KEY_VOLUNTEER: "Key Volunteer",
};

/** The boundary that opens membership year `year`. */
function yearStart(boundary: Date, year: number): Date {
    return new Date(Date.UTC(year, boundary.getUTCMonth(), boundary.getUTCDate()));
}

/** The earliest check date valid at the start of membership year `year`. */
export function checkValidFromForYear(boundary: Date, recheckMonths: number, year: number): Date {
    return bgFreshThreshold(yearStart(boundary, year), recheckMonths);
}

export function positionCheckStanding(lastBackgroundCheck: Date | null, validFrom: Date): PositionCheckStanding {
    if (!lastBackgroundCheck) return "NO_CHECK";
    return lastBackgroundCheck.getTime() >= validFrom.getTime() ? "CURRENT" : "NOT_CURRENT";
}

/**
 * Every person holding a position that needs a current background check, one row
 * per person. Program positions serve in their program's year and stop counting once
 * the program ends; bucket places and roles serve in the live membership year. A
 * person known to be under 18 at the start of that year is left out, since a minor
 * is never checked. `today` is the org's calendar day that picks the live year and
 * judges a program's end.
 */
export async function positionHolders(db: DbClient, boundary: Date, recheckMonths: number, today: Date): Promise<PositionHolderRow[]> {
    const liveYear = liveMembershipYear(boundary, today)!;
    const runningProgram = { endAt: { gte: today } };
    const [volunteers, programs, runs, buckets, treasurers, roles] = await Promise.all([
        db.programVolunteer.findMany({ where: { program: runningProgram }, select: { personId: true, isCore: true, program: { select: { name: true, appliesToYear: true } } } }),
        db.program.findMany({ where: { ...runningProgram, leadMentorId: { not: null } }, select: { leadMentorId: true, name: true, appliesToYear: true } }),
        db.programInstance.findMany({
            where: { leadMentorId: { not: null }, program: runningProgram, OR: [{ endAt: null }, { endAt: { gte: today } }] },
            select: { leadMentorId: true, name: true, program: { select: { name: true, appliesToYear: true } } },
        }),
        db.budgetOwner.findMany({ where: { archivedAt: null, ownerId: { not: null } }, select: { ownerId: true, name: true } }),
        db.budgetOwnerTreasurer.findMany({ where: { budgetOwner: { archivedAt: null } }, select: { personId: true, budgetOwner: { select: { name: true } } } }),
        db.personRole.findMany({ select: { personId: true, role: true } }),
    ]);

    const held = new Map<number, Position[]>();
    const hold = (personId: number, position: Position) => held.set(personId, [...(held.get(personId) ?? []), position]);
    for (const v of volunteers) {
        hold(v.personId, { kind: v.isCore ? "CORE_VOLUNTEER" : "VOLUNTEER", label: `${v.isCore ? "Core volunteer" : "Volunteer"}: ${v.program.name}`, year: v.program.appliesToYear });
    }
    for (const p of programs) hold(p.leadMentorId!, { kind: "PROGRAM_LEADER", label: `Program leader: ${p.name}`, year: p.appliesToYear });
    for (const r of runs) hold(r.leadMentorId!, { kind: "RUN_LEADER", label: `Run leader: ${r.program.name} (${r.name})`, year: r.program.appliesToYear });
    for (const b of buckets) hold(b.ownerId!, { kind: "BUCKET_OWNER", label: `Bucket owner: ${b.name}`, year: liveYear });
    for (const t of treasurers) hold(t.personId, { kind: "BUCKET_TREASURER", label: `Bucket treasurer: ${t.budgetOwner.name}`, year: liveYear });
    for (const r of roles) hold(r.personId, { kind: r.role, label: `Role: ${ROLE_LABEL[r.role]}`, year: liveYear });

    if (!held.size) return [];
    const people = await db.person.findMany({
        where: { id: { in: [...held.keys()] } },
        select: { id: true, name: true, householdId: true, dateOfBirth: true, lastBackgroundCheck: true },
        orderBy: { name: "asc" },
    });
    return people.flatMap((p) => {
        const positions = held.get(p.id)!;
        const year = Math.max(...positions.map((x) => x.year));
        if (p.dateOfBirth && calculateAge(p.dateOfBirth, yearStart(boundary, year)) < 18) return [];
        return [{
            personId: p.id,
            name: p.name || `Person #${p.id}`,
            householdId: p.householdId,
            positions,
            year,
            lastBackgroundCheck: p.lastBackgroundCheck?.toISOString() ?? null,
            standing: positionCheckStanding(p.lastBackgroundCheck, checkValidFromForYear(boundary, recheckMonths, year)),
        }];
    });
}
