import type { Prisma } from "@/generated/prisma/client";
import prisma from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { orgToday } from "@/lib/appSettings";
import { ENROLLED_PARTICIPANT } from "@/lib/person/filters";
import { personOrSystemActor, systemActor } from "@/lib/auditActor";
import { isAdultAsOf, isMinorAsOf } from "@/lib/household/secondLead";
import { fromWhere } from "@/lib/membership/lifecycle";
import type { TxClient } from "@/lib/db-client";

/**
 * Triggers that open a per-person membership-agreement obligation (PERSON_AGREEMENT). A
 * household's leads sign the household agreement, a partner or spouse being made a lead;
 * every other adult in it signs their own, opened only once they take part: enrolling in,
 * volunteering on or leading a program.
 */

/** A span of calendar days, `start` inclusive and `end` exclusive. */
export type DayWindow = { start: Date; end: Date };

const yearsAfter = (d: Date, years: number) => new Date(Date.UTC(d.getUTCFullYear() + years, d.getUTCMonth(), d.getUTCDate()));

/**
 * The membership year in progress on `today`, an org calendar day: it starts at the latest
 * boundary on or before that day. Unlike membershipYearCycle, the renewal window does not
 * move it early, so a new year's agreements open on the boundary itself.
 */
export function membershipYearAt(configuredBoundary: Date, today: Date): DayWindow {
    let start = new Date(Date.UTC(today.getUTCFullYear(), configuredBoundary.getUTCMonth(), configuredBoundary.getUTCDate()));
    if (start > today) start = yearsAfter(start, -1);
    return { start, end: yearsAfter(start, 1) };
}

/** The membership year before `year`. */
export function previousMembershipYear(year: DayWindow): DayWindow {
    return { start: yearsAfter(year.start, -1), end: year.start };
}

/** Enrolled in, volunteering on, or leading a program whose dates overlap `window`. */
export function tookPartWhere(window: DayWindow): Prisma.PersonWhereInput {
    const program: Prisma.ProgramWhereInput = { startAt: { lt: window.end }, endAt: { gte: window.start } };
    return {
        OR: [
            { programParticipants: { some: { program, ...ENROLLED_PARTICIPANT } } },
            { programVolunteers: { some: { program } } },
            { programsLed: { some: program } },
        ],
    };
}

/** Who the automatic rule asks to sign, age aside: someone who isn't a lead, in a member household. */
export const AGREEMENT_OWED_WHERE = {
    isHouseholdLead: false,
    household: { orgMembership: { status: "ACTIVE" as const } },
} satisfies Prisma.PersonWhereInput;

/**
 * Already handled: an obligation still in flight (from any year, since an unsigned one is
 * no reason to open a second), or one settled since `since`.
 */
export function agreementHandledSinceWhere(personId: number, since: Date) {
    return {
        kind: "PERSON_AGREEMENT" as const,
        subjectPersonId: personId,
        OR: [
            { status: "PENDING_EXTERNAL_ACTION" as const },
            { status: { in: ["ACTIVE" as const, "ARCHIVED" as const] }, stageEnteredAt: { gte: since } },
        ],
    };
}

/** Where a current agreement is counted from: the membership year's start, or the epoch with no boundary set. */
async function currentAgreementSince(today: Date): Promise<Date> {
    const settings = await prisma.boardSettings.findUnique({ where: { id: 1 } });
    return settings?.orgMembershipYearBoundary ? membershipYearAt(settings.orgMembershipYearBoundary, today).start : new Date(0);
}

/**
 * Open one PERSON_AGREEMENT for `personId` unless one is handled since `since`. Idempotent
 * and concurrency-safe: a FOR UPDATE lock on the Person row serializes the check-then-insert,
 * so the yearly pass and an enrolment can't both open one.
 *
 * Automatic opens need the AGREEMENT_OWED_WHERE person, 18 or over. `manual: true` is the
 * Board's open: any non-lead who isn't a known minor. A lead is always refused, since an
 * open PERSON_AGREEMENT on a lead would shadow their household signing.
 *
 * `today` is the org's calendar day the age rule is judged on.
 *
 * Returns the created process, or null when skipped.
 */
export async function openPersonAgreement(
    personId: number,
    today: Date,
    since: Date,
    { manual = false, actorId }: { manual?: boolean; actorId?: number } = {},
) {
    return prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Person" WHERE id = ${personId} FOR UPDATE`;
        const person = await tx.person.findUnique({
            where: { id: personId },
            select: {
                dateOfBirth: true,
                isDeclaredAdult: true,
                isHouseholdLead: true,
                household: { select: { orgMembership: { select: { status: true } } } },
            },
        });
        if (!person || person.isHouseholdLead) return null;
        if (manual ? isMinorAsOf(person, today) : !(isAdultAsOf(person, today) && person.household.orgMembership?.status === "ACTIVE")) return null;

        const handled = await tx.orgMembershipProcess.findFirst({
            where: agreementHandledSinceWhere(personId, since),
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
 * The yearly re-sign, run nightly. Opens an agreement for each adult non-lead who took part in
 * the previous membership year or this one and has none opened or signed since this year's
 * start: the new year's re-sign once a year has started, and a retry for anyone whose open on
 * taking part failed. Idempotent, so each person is asked once a year. No boundary
 * configured: there is no year, and it does nothing.
 */
export async function runPersonAgreementSweep(now: Date) {
    const settings = await prisma.boardSettings.findUnique({ where: { id: 1 } });
    if (!settings?.orgMembershipYearBoundary) return { opened: 0, failed: 0, reason: "no membership-year boundary configured" };

    const today = await orgToday(now);
    const year = membershipYearAt(settings.orgMembershipYearBoundary, today);
    const people = await prisma.person.findMany({
        where: { ...AGREEMENT_OWED_WHERE, ...tookPartWhere({ start: previousMembershipYear(year).start, end: year.end }) },
        select: { id: true },
    });

    let opened = 0;
    let failed = 0;
    for (const p of people) {
        try {
            if (await openPersonAgreement(p.id, today, year.start)) opened++;
        } catch (err) {
            failed++;
            logger.error(`Failed to open an individual membership agreement for person ${p.id}:`, err);
        }
    }
    return { opened, failed, yearStart: year.start.toISOString() };
}

/**
 * A person just took part: enrolled in a program, was made a volunteer, or was named its
 * leader. Opens their agreement when they owe one and have none for the current year.
 * Never throws: taking part must not fail because the agreement couldn't open, and the
 * nightly sweep opens it instead.
 */
export async function openPersonAgreementOnEngage(personId: number, now: Date = new Date()) {
    try {
        const today = await orgToday(now);
        return await openPersonAgreement(personId, today, await currentAgreementSince(today));
    } catch (err) {
        logger.error(`Failed to open an individual membership agreement for person ${personId} on taking part:`, err);
        return null;
    }
}

/**
 * New-member activation (INITIAL -> ACTIVE): the household's adult non-leads who already
 * take part this year get their agreement now, since the membership they join
 * under has only just started. No-op when no boundary is configured.
 */
export async function openPersonAgreementForNewMember(householdId: number, asOf: Date) {
    const settings = await prisma.boardSettings.findUnique({ where: { id: 1 } });
    if (!settings?.orgMembershipYearBoundary) return;

    const today = await orgToday(asOf);
    const year = membershipYearAt(settings.orgMembershipYearBoundary, today);
    const people = await prisma.person.findMany({
        where: { householdId, ...AGREEMENT_OWED_WHERE, ...tookPartWhere(year) },
        select: { id: true },
    });
    for (const p of people) await openPersonAgreement(p.id, today, year.start);
}

export class PersonAgreementError extends Error {
    constructor(public readonly code: "is_lead" | "minor" | "not_opened", message: string) {
        super(message);
        this.name = "PersonAgreementError";
    }
}

/**
 * The Board's open: any adult who isn't a lead, an unknown age included. Refuses with a reason rather than no-oping, so the Board sees why.
 * Idempotent: an obligation already open is returned as-is.
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
    if (isMinorAsOf(person, today)) {
        throw new PersonAgreementError("minor", "This person's date of birth shows they are under 18.");
    }

    await openPersonAgreement(personId, today, await currentAgreementSince(today), { manual: true, actorId });
    const open = await findOpenPersonAgreement(personId);
    if (!open) throw new PersonAgreementError("not_opened", "This person already signed an individual agreement for this membership year.");
    return open;
}

/**
 * A person was just made a household lead: they sign the household agreement now, so their
 * open, unsigned individual agreement is closed. A signed one is left alone. Runs inside the
 * promotion's transaction.
 */
export async function closePersonAgreementOnLead(tx: TxClient, personId: number) {
    const open = await tx.orgMembershipProcess.findMany({
        where: { kind: "PERSON_AGREEMENT", subjectPersonId: personId, contractSignedAt: null, ...fromWhere("PENDING_EXTERNAL_ACTION") },
        select: { id: true },
    });
    for (const { id } of open) {
        const { count } = await tx.orgMembershipProcess.updateMany({
            where: { id, contractSignedAt: null, ...fromWhere("PENDING_EXTERNAL_ACTION") },
            data: { status: "ARCHIVED", stageEnteredAt: new Date() },
        });
        if (count === 0) continue;
        await tx.auditLog.create({
            data: {
                ...systemActor("system:person-agreement-close-on-lead"),
                action: "EDIT",
                tableName: "OrgMembershipProcess",
                affectedEntityId: id,
                oldData: { status: "PENDING_EXTERNAL_ACTION" },
                newData: { status: "ARCHIVED", subjectPersonId: personId },
            },
        });
    }
}
