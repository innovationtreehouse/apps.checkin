import prisma from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { calculateAge } from "@/lib/time";
import { orgToday } from "@/lib/appSettings";
import { renewalWindow } from "@/lib/membership/renewal";
import { ENROLLED_PARTICIPANT, recentProgramWhere } from "@/lib/person/filters";
import { personOrSystemActor } from "@/lib/auditActor";

/**
 * Triggers that OPEN a per-person membership-agreement obligation (PERSON_AGREEMENT).
 * An 18+ child of the household lead is a legal adult and cannot be bound by their
 * parent's signature, so they sign their own agreement.
 *
 * Two things diverge from personBgTriggers.ts on
 * purpose — age is judged as-of NOW (not as-of the boundary) and the trigger runs
 * NIGHTLY (not annually). Both are load-bearing; see below.
 */


/**
 * Automatic-population age rule: a DOB on file and 18–25 as of `today`.
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
 * Age is as-of today, NOT as-of the membership-year boundary. Boundary-relative age (what
 * personBgVerdict does) evaluated by a nightly job would flag a 17-year-old whose 18th
 * birthday merely falls before the next boundary — asking a minor to sign a contract they
 * can't be bound by, the exact failure this feature exists to prevent.
 *
 * `today` is the org's calendar day (`orgToday`), so the band opens at the org's local
 * midnight, not at UTC midnight the evening before.
 */
export function inAgreementAgeBand(person: { dateOfBirth: Date | null; isDeclaredAdult: boolean }, today: Date): boolean {
    if (!person.dateOfBirth) return false;
    const age = calculateAge(person.dateOfBirth, today);
    return age >= 18 && age <= 25;
}

/**
 * Manual (board) age rule: we can tell they're an adult at all. Looser than the band —
 * the board can see that a 27-year-old is an adult child and not a spouse — but an unknown
 * age is still refused, since we can neither confirm they're 18 nor treat them as adult.
 * Same population the compliance dashboard reports as DOB_MISSING.
 */
export function hasKnownAdultAge(person: { dateOfBirth: Date | null; isDeclaredAdult: boolean }, today: Date): boolean {
    if (person.isDeclaredAdult) return true;
    return !!person.dateOfBirth && calculateAge(person.dateOfBirth, today) >= 18;
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
export function agreementCycleFloor(configuredBoundary: Date, today: Date): Date {
    const { windowStart } = renewalWindow(configuredBoundary, today);
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
 * `today` is the org's calendar day the age rule is judged on.
 *
 * Returns the created process, or null when skipped.
 */
export async function openPersonAgreement(
    personId: number,
    today: Date,
    floor: Date,
    { manual = false, actorId }: { manual?: boolean; actorId?: number } = {},
) {
    return prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Person" WHERE id = ${personId} FOR UPDATE`;
        const person = await tx.person.findUnique({
            where: { id: personId },
            select: { dateOfBirth: true, isDeclaredAdult: true, isHouseholdLead: true },
        });
        if (!person) return null;
        if (person.isHouseholdLead) return null;
        if (!(manual ? hasKnownAdultAge(person, today) : inAgreementAgeBand(person, today))) return null;

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
    }, { maxWait: 5_000, timeout: 15_000 });
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
export function autoPopulationWhere(today: Date) {
    const program = recentProgramWhere(today);
    return {
        isHouseholdLead: false,
        household: { orgMembership: { status: "ACTIVE" as const } },
        OR: [
            { programParticipants: { some: { program, ...ENROLLED_PARTICIPANT } } },
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
    if (!settings?.orgMembershipYearBoundary) return { opened: 0, failed: 0, reason: "no membership-year boundary configured" };

    const today = await orgToday(now);
    const floor = agreementCycleFloor(settings.orgMembershipYearBoundary, today);
    const people = await prisma.person.findMany({ where: { ...autoPopulationWhere(today) }, select: { id: true } });

    let opened = 0;
    let failed = 0;
    for (const p of people) {
        try {
            if (await openPersonAgreement(p.id, today, floor)) opened++;
        } catch (err) {
            failed++;
            logger.error(`Failed to open an individual membership agreement for person ${p.id}:`, err);
        }
    }
    return { opened, failed, floor: floor.toISOString() };
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

    const today = await orgToday(asOf);
    const floor = agreementCycleFloor(settings.orgMembershipYearBoundary, today);
    const people = await prisma.person.findMany({
        where: { householdId, ...autoPopulationWhere(today) },
        select: { id: true },
    });
    for (const p of people) await openPersonAgreement(p.id, today, floor);
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
    const today = await orgToday(now);
    if (!hasKnownAdultAge(person, today)) {
        throw new PersonAgreementError("age_unknown", "Record this person's date of birth (or mark them over 25) first.");
    }

    const settings = await prisma.boardSettings.findUnique({ where: { id: 1 } });
    // No boundary configured: no cycle to dedup against, so fall back to "one ever".
    const floor = settings?.orgMembershipYearBoundary ? agreementCycleFloor(settings.orgMembershipYearBoundary, today) : new Date(0);

    await openPersonAgreement(personId, today, floor, { manual: true, actorId });
    const open = await findOpenPersonAgreement(personId);
    if (!open) throw new PersonAgreementError("not_opened", "This person already signed an individual agreement for this cycle.");
    return open;
}
