import prisma from "@/lib/prisma";
import { calculateAge, orgCalendarDay } from "@/lib/time";
import { renewalWindow } from "@/lib/membership/renewal";
import { LIVE_PERSON, recentProgramWhere } from "@/lib/person/filters";
import { personOrSystemActor } from "@/lib/auditActor";

/**
 * Triggers that OPEN a per-person membership-agreement obligation (PERSON_AGREEMENT).
 * An 18+ child of the household lead is a legal adult and cannot be bound by their
 * parent's signature, so they sign their own agreement.
 *
 * Rules: docs/rules/membership.md. Two things diverge from personBgTriggers.ts on
 * purpose — age is judged as-of NOW (not as-of the boundary) and the trigger runs
 * NIGHTLY (not annually). Both are load-bearing; see below.
 */


/**
 * Automatic-population age rule: a DOB on file and 18–25 as of `now`.
 *
 * The band is the spouse guard. `isDeclaredAdult` means "over 25, no DOB" — set by the
 * intake checkbox and stamped by the nightly DOB purge as people cross 26. A non-lead
 * adult over 25 is a spouse the household never marked as a lead, or an adult child who
 * should have their own household by now: household hygiene, not a signature obligation.
 * A non-lead 18–25 with a DOB is a child who turned 18.
 *
 * The ceiling is explicit even though the purge makes it redundant today (a DOB implies
 * ≤25), because the implicit version has a reachable hole: a household adds a 30-year-old
 * spouse with a DOB and doesn't mark them a lead — until the next purge runs they'd qualify.
 *
 * Age is as-of `now`, NOT as-of the membership-year boundary. Boundary-relative age (what
 * personBgVerdict does) evaluated by a nightly job would flag a 17-year-old whose 18th
 * birthday merely falls before the next boundary — asking a minor to sign a contract they
 * can't be bound by, the exact failure this feature exists to prevent.
 *
 * `now` is an instant, so the age is judged on the calendar day it falls on in the org's
 * zone: the band opens at local midnight, not at 7 PM the evening before.
 */
export function inAgreementAgeBand(person: { dateOfBirth: Date | null; isDeclaredAdult: boolean }, now: Date): boolean {
    if (!person.dateOfBirth) return false;
    const age = calculateAge(person.dateOfBirth, orgCalendarDay(now));
    return age >= 18 && age <= 25;
}

/**
 * Manual (board) age rule: we can tell they're an adult at all. Looser than the band —
 * the board can see that a 27-year-old is an adult child and not a spouse — but an unknown
 * age is still refused, since we can neither confirm they're 18 nor treat them as adult.
 * Same population the compliance dashboard reports as DOB_MISSING.
 */
export function hasKnownAdultAge(person: { dateOfBirth: Date | null; isDeclaredAdult: boolean }, now: Date): boolean {
    if (person.isDeclaredAdult) return true;
    return !!person.dateOfBirth && calculateAge(person.dateOfBirth, orgCalendarDay(now)) >= 18;
}

/**
 * Dedup floor: a PERSON_AGREEMENT settled at or after this already covers the current
 * cycle. It is the current cycle's start boundary backed off by the renewal lead window —
 * `renewalWindow` gives that window before the UPCOMING boundary, so one year back lands
 * on the same allowance for the cycle we're actually in.
 *
 * The lead-window backoff is what stops a double-ask: someone who starts qualifying two
 * weeks before a boundary signs, and a floor set at the boundary itself would ask them
 * again days later. runRenewalSweep makes the same allowance via settledThisCycleWhere,
 * so the individual agreement and the household agreement roll on one cycle.
 */
export function agreementCycleFloor(configuredBoundary: Date, now: Date): Date {
    const { windowStart } = renewalWindow(configuredBoundary, now);
    const floor = new Date(windowStart);
    floor.setUTCFullYear(floor.getUTCFullYear() - 1);
    return floor;
}

/**
 * Already handled: an obligation still in flight (from any cycle — an unsigned one is no
 * reason to open a second), or one settled since `floor`. The settled arm matches
 * lifecycle.settledThisCycleWhere's shape; written here because this probe is pinned to
 * kind: "PERSON_AGREEMENT" + subject and also needs the in-flight arm.
 */
function handledThisCycleWhere(personId: number, floor: Date) {
    return {
        kind: "PERSON_AGREEMENT" as const,
        subjectPersonId: personId,
        OR: [
            { status: "PENDING_EXTERNAL_ACTION" as const },
            { status: { in: ["ACTIVE" as const, "ARCHIVED" as const] }, stageEnteredAt: { gte: floor } },
        ],
    };
}

/**
 * Open one PERSON_AGREEMENT for `personId`. Idempotent + concurrency-safe: a FOR UPDATE
 * lock on the Person row serializes the check-then-insert (mirrors openPersonBg), so the
 * nightly pass and an activation can't both open one.
 *
 * `manual: true` is the board button — it drops the age ceiling (the board judges spouse
 * vs. adult child itself) but keeps the household-lead refusal, which is not cosmetic: an
 * open PERSON_AGREEMENT on a lead would shadow their household signing flow.
 *
 * Returns the created process, or null when skipped.
 */
export async function openPersonAgreement(
    personId: number,
    now: Date,
    floor: Date,
    { manual = false, actorId }: { manual?: boolean; actorId?: number } = {},
) {
    return prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Person" WHERE id = ${personId} FOR UPDATE`;
        const person = await tx.person.findUnique({
            where: { id: personId },
            select: { dateOfBirth: true, isDeclaredAdult: true, isHouseholdLead: true, mergedIntoId: true },
        });
        if (!person || person.mergedIntoId) return null;
        if (person.isHouseholdLead) return null;
        if (!(manual ? hasKnownAdultAge(person, now) : inAgreementAgeBand(person, now))) return null;

        const handled = await tx.orgMembershipProcess.findFirst({
            where: handledThisCycleWhere(personId, floor),
            select: { id: true },
        });
        if (handled) return null;

        const created = await tx.orgMembershipProcess.create({
            data: {
                kind: "PERSON_AGREEMENT",
                subjectPersonId: personId,
                orgMembershipId: null,
                status: "PENDING_EXTERNAL_ACTION",
            },
        });
        await tx.auditLog.create({
            data: {
                ...personOrSystemActor(actorId, "system:person-agreement-open"),
                action: "CREATE",
                tableName: "OrgMembershipProcess",
                affectedEntityId: created.id,
                newData: { kind: "PERSON_AGREEMENT", status: "PENDING_EXTERNAL_ACTION", subjectPersonId: personId },
            },
        });
        return created;
    });
}

/** The caller's own open agreement, if any — the process they sign on /membership. */
export function findOpenPersonAgreement(personId: number) {
    return prisma.orgMembershipProcess.findFirst({
        where: { kind: "PERSON_AGREEMENT", subjectPersonId: personId, status: "PENDING_EXTERNAL_ACTION" },
        orderBy: { id: "desc" },
    });
}

/**
 * The automatic population: non-lead, in a member household, live, recently
 * program-attached, and inside the age band. The age band can't be expressed in Prisma
 * (calculateAge is UTC month/day math), so it's applied per-person inside
 * openPersonAgreement.
 */
export function autoPopulationWhere(now: Date) {
    const program = recentProgramWhere(now);
    return {
        isHouseholdLead: false,
        household: { orgMembership: { status: "ACTIVE" as const } },
        OR: [
            { programParticipants: { some: { program } } },
            { programVolunteers: { some: { program } } },
            { programsLed: { some: program } },
        ],
    };
}

/**
 * Nightly pass. Opens the first agreement for anyone who has started qualifying, and a
 * fresh one for anyone whose last is older than the current cycle — one mechanism, no
 * separate annual sweep.
 *
 * Nightly is a correctness requirement, not a convenience: a once-a-year sweep misses
 * everyone who starts qualifying after it fires (a 19-year-old added to a program the day
 * after the boundary would wait a full year). Idempotent, so a daily run is free.
 */
export async function runPersonAgreementSweep(now: Date) {
    const settings = await prisma.boardSettings.findUnique({ where: { id: 1 } });
    if (!settings?.orgMembershipYearBoundary) return { opened: 0, reason: "no membership-year boundary configured" };

    const floor = agreementCycleFloor(settings.orgMembershipYearBoundary, now);
    const people = await prisma.person.findMany({ where: { ...autoPopulationWhere(now), ...LIVE_PERSON }, select: { id: true } });

    let opened = 0;
    for (const p of people) {
        if (await openPersonAgreement(p.id, now, floor)) opened++;
    }
    return { opened, floor: floor.toISOString() };
}

/**
 * New-member activation (INITIAL -> ACTIVE). Strictly an optimization over waiting for the
 * next nightly pass, so a joining household's adult child isn't asked a day late; the
 * nightly run would catch them regardless. No-op when no boundary is configured — without
 * one there is no cycle to dedup against, and the nightly pass is skipped for the same reason.
 */
export async function openPersonAgreementForNewMember(householdId: number, asOf: Date) {
    const settings = await prisma.boardSettings.findUnique({ where: { id: 1 } });
    if (!settings?.orgMembershipYearBoundary) return;

    const floor = agreementCycleFloor(settings.orgMembershipYearBoundary, asOf);
    const people = await prisma.person.findMany({
        where: { householdId, ...autoPopulationWhere(asOf), ...LIVE_PERSON },
        select: { id: true },
    });
    for (const p of people) await openPersonAgreement(p.id, asOf, floor);
}

export class PersonAgreementError extends Error {
    constructor(public readonly code: "is_lead" | "age_unknown" | "not_opened", message: string) {
        super(message);
        this.name = "PersonAgreementError";
    }
}

/**
 * Manual board open — the escape hatch for someone the automatic rule doesn't reach (not
 * program-attached, or over the age ceiling). Refuses with a reason rather than no-oping,
 * so the board sees why. Idempotent: an existing obligation for this cycle is returned as-is.
 */
export async function openPersonAgreementForBoard(personId: number, actorId: number, now = new Date()) {
    const person = await prisma.person.findUnique({
        where: { id: personId },
        select: { dateOfBirth: true, isDeclaredAdult: true, isHouseholdLead: true },
    });
    if (!person) throw new PersonAgreementError("not_opened", "Person not found.");
    if (person.isHouseholdLead) {
        throw new PersonAgreementError("is_lead", "A household lead signs the household agreement, not an individual one.");
    }
    if (!hasKnownAdultAge(person, now)) {
        throw new PersonAgreementError("age_unknown", "Record this person's date of birth (or mark them over 25) first.");
    }

    const settings = await prisma.boardSettings.findUnique({ where: { id: 1 } });
    // No boundary configured: no cycle to dedup against, so fall back to "one ever".
    const floor = settings?.orgMembershipYearBoundary ? agreementCycleFloor(settings.orgMembershipYearBoundary, now) : new Date(0);

    await openPersonAgreement(personId, now, floor, { manual: true, actorId });
    const open = await findOpenPersonAgreement(personId);
    if (!open) throw new PersonAgreementError("not_opened", "This person already signed an individual agreement for this cycle.");
    return open;
}
