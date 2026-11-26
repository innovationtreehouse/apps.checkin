import type { Prisma } from "@/generated/prisma/client";
import prisma from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { orgToday } from "@/lib/appSettings";
import { ENROLLED_PARTICIPANT } from "@/lib/person/filters";
import { personOrSystemActor, systemActor } from "@/lib/auditActor";
import { isAdultAsOf, isMinorAsOf } from "@/lib/household/secondLead";
import { fromWhere, membershipFeeSettledAwaitingBg } from "@/lib/membership/lifecycle";
import { membershipYearEnded, membershipYearLabel } from "@/lib/programYear";
import type { DbClient, TxClient } from "@/lib/db-client";

// Loaded on use: external.ts imports this module.
const externalModule = () => import("@/lib/membership/external");

/**
 * Triggers that open a per-person membership-agreement obligation (PERSON_AGREEMENT). A
 * household's leads sign the household agreement, a partner or spouse being made a lead;
 * every other adult in it signs their own, opened only once they take part: enrolling in,
 * volunteering on or leading a program. Each agreement is for one membership year, stored
 * when it opens; a signature counts for that year only.
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
 * Already handled for membership year `year`: an obligation still in flight (from any year,
 * since an unsigned one is no reason to open a second), or one signed or closed for `year`.
 */
export function agreementHandledForYearWhere(personId: number, year: number) {
    return {
        kind: "PERSON_AGREEMENT" as const,
        subjectPersonId: personId,
        OR: [
            { status: "PENDING_EXTERNAL_ACTION" as const },
            { status: { in: ["ACTIVE" as const, "ARCHIVED" as const] }, membershipYear: year },
        ],
    };
}

/** The highest membership year a household has paid for among its settled applications, or null. */
export async function householdLatestPaidYear(householdId: number, db: DbClient = prisma): Promise<number | null> {
    const latest = await db.orgMembershipProcess.findFirst({
        where: { orgMembership: { householdId }, kind: { in: ["INITIAL", "RENEWAL"] }, OR: [{ status: "ACTIVE" }, membershipFeeSettledAwaitingBg.where], appliesToYear: { not: null } },
        orderBy: { appliesToYear: "desc" },
        select: { appliesToYear: true },
    });
    return latest?.appliesToYear ?? null;
}

/** Each household's latest paid year, keyed by household; a household that has paid for none is absent. */
export async function householdsLatestPaidYears(householdIds: readonly number[], db: DbClient = prisma): Promise<Map<number, number>> {
    const rows = householdIds.length
        ? await db.orgMembershipProcess.findMany({
              where: { orgMembership: { householdId: { in: [...householdIds] } }, kind: { in: ["INITIAL", "RENEWAL"] }, OR: [{ status: "ACTIVE" }, membershipFeeSettledAwaitingBg.where], appliesToYear: { not: null } },
              select: { appliesToYear: true, orgMembership: { select: { householdId: true } } },
          })
        : [];
    const latest = new Map<number, number>();
    for (const r of rows) {
        const householdId = r.orgMembership?.householdId;
        if (householdId == null || r.appliesToYear == null) continue;
        latest.set(householdId, Math.max(latest.get(householdId) ?? r.appliesToYear, r.appliesToYear));
    }
    return latest;
}

/** The household's latest paid year for `personId`, or null when they have no household or it has paid for none. */
async function personLatestPaidYear(personId: number): Promise<number | null> {
    const person = await prisma.person.findUnique({ where: { id: personId }, select: { householdId: true } });
    return person?.householdId == null ? null : householdLatestPaidYear(person.householdId);
}

/**
 * Open one PERSON_AGREEMENT for `personId` for membership year `year` unless one is handled for it. Idempotent
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
    year: number,
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
            where: agreementHandledForYearWhere(personId, year),
            select: { id: true },
        });
        if (handled) return null;

        const created = await tx.orgMembershipProcess.create({
            data: {
                kind: "PERSON_AGREEMENT",
                subjectPersonId: personId,
                orgMembershipId: null,
                status: "PENDING_EXTERNAL_ACTION",
                membershipYear: year,
            },
        });
        await tx.auditLog.create({
            data: {
                ...personOrSystemActor(actorId, "system:person-agreement-open"),
                action: "CREATE",
                tableName: "OrgMembershipProcess",
                affectedEntityId: created.id,
                newData: { kind: "PERSON_AGREEMENT", status: "PENDING_EXTERNAL_ACTION", subjectPersonId: personId, membershipYear: year },
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
 * The nightly pass. First closes every open agreement whose year has ended
 * ({@link closeEndedAgreements}). Then opens an agreement for each adult non-lead who took
 * part in the previous membership year or this one, for their household's latest paid
 * year, unless they have one for that year or one open: the new year's re-sign once the
 * household has paid for it, and a retry for anyone whose open on taking part failed.
 * Idempotent, so each person is asked once a year. No boundary configured: there is no
 * year, and it does nothing.
 */
export async function runPersonAgreementSweep(now: Date) {
    const settings = await prisma.boardSettings.findUnique({ where: { id: 1 } });
    if (!settings?.orgMembershipYearBoundary) return { opened: 0, failed: 0, closedAtYearEnd: 0, closeFailed: 0, reason: "no membership-year boundary configured" };

    const today = await orgToday(now);
    const closed = await closeEndedAgreements(settings.orgMembershipYearBoundary, today);
    const year = membershipYearAt(settings.orgMembershipYearBoundary, today);
    const people = await prisma.person.findMany({
        where: { ...AGREEMENT_OWED_WHERE, ...tookPartWhere({ start: previousMembershipYear(year).start, end: year.end }) },
        select: { id: true, householdId: true },
    });

    const paidYears = new Map<number, number | null>();
    let opened = 0;
    let failed = 0;
    for (const p of people) {
        try {
            if (!paidYears.has(p.householdId)) paidYears.set(p.householdId, await householdLatestPaidYear(p.householdId));
            const paidYear = paidYears.get(p.householdId);
            if (paidYear != null && await openPersonAgreement(p.id, today, paidYear)) opened++;
        } catch (err) {
            failed++;
            logger.error(`Failed to open an individual membership agreement for person ${p.id}:`, err);
        }
    }
    return { opened, failed, ...closed, yearStart: year.start.toISOString() };
}

/**
 * Closes every open agreement whose membership year has ended on `today`, through
 * closeEndedPersonAgreement. A Zoho failure leaves that agreement open and is retried
 * the next night.
 */
async function closeEndedAgreements(boundary: Date, today: Date) {
    const open = await prisma.orgMembershipProcess.findMany({
        where: { kind: "PERSON_AGREEMENT", contractSignedAt: null, membershipYear: { not: null }, ...fromWhere("PENDING_EXTERNAL_ACTION") },
        select: { id: true, zohoEnvelopeId: true, membershipYear: true },
    });
    const ended = open.filter((p) => p.membershipYear !== null && membershipYearEnded(p.membershipYear, boundary, today));
    if (!ended.length) return { closedAtYearEnd: 0, closeFailed: 0 };
    const { closeEndedPersonAgreement } = await externalModule();
    let closedAtYearEnd = 0;
    let closeFailed = 0;
    for (const p of ended) {
        try {
            if ((await closeEndedPersonAgreement(p)) === "closed") closedAtYearEnd++;
        } catch (err) {
            closeFailed++;
            logger.error(`Failed to close individual membership agreement ${p.id} at its year's end:`, err);
        }
    }
    return { closedAtYearEnd, closeFailed };
}

/**
 * A person just took part: enrolled in a program, was made a volunteer, or was named its
 * leader. Opens their agreement for their household's latest paid year when they owe one
 * and have none for it. Never throws: taking part must not fail because the agreement
 * couldn't open, and the nightly sweep opens it instead.
 */
export async function openPersonAgreementOnEngage(personId: number, now: Date = new Date()) {
    try {
        const year = await personLatestPaidYear(personId);
        if (year === null) return null;
        return await openPersonAgreement(personId, await orgToday(now), year);
    } catch (err) {
        logger.error(`Failed to open an individual membership agreement for person ${personId} on taking part:`, err);
        return null;
    }
}

/**
 * New-member activation (INITIAL -> ACTIVE): the household's adult non-leads who already
 * take part this year get their agreement now, for the year the activating application
 * paid for, since the membership they join under has only just started. No-op when no
 * boundary is configured or the application records no paid year.
 */
export async function openPersonAgreementForNewMember(householdId: number, processId: number, asOf: Date) {
    const settings = await prisma.boardSettings.findUnique({ where: { id: 1 } });
    if (!settings?.orgMembershipYearBoundary) return;
    const activated = await prisma.orgMembershipProcess.findUnique({ where: { id: processId }, select: { appliesToYear: true } });
    if (activated?.appliesToYear == null) return;

    const today = await orgToday(asOf);
    const year = membershipYearAt(settings.orgMembershipYearBoundary, today);
    const people = await prisma.person.findMany({
        where: { householdId, ...AGREEMENT_OWED_WHERE, ...tookPartWhere(year) },
        select: { id: true },
    });
    for (const p of people) await openPersonAgreement(p.id, today, activated.appliesToYear);
}

export class PersonAgreementError extends Error {
    constructor(public readonly code: "is_lead" | "minor" | "not_opened", message: string) {
        super(message);
        this.name = "PersonAgreementError";
    }
}

/**
 * The Board's open, for the membership year `year` the Board picks: any adult who isn't a lead, an unknown age included.
 * Refuses with a reason rather than no-oping, so the Board sees why. Idempotent: an obligation already open is returned as-is.
 */
export async function openPersonAgreementForBoard(personId: number, actorId: number, year: number, now = new Date()) {
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

    await openPersonAgreement(personId, today, year, { manual: true, actorId });
    const open = await findOpenPersonAgreement(personId);
    if (!open) throw new PersonAgreementError("not_opened", `This person already has an individual agreement for ${membershipYearLabel(year)}.`);
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
