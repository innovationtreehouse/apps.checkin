import prisma from "@/lib/prisma";
import { bgFreshThreshold, personBgVerdict } from "@/lib/membership/personBgCheck";
import { nextBoundary } from "@/lib/membership/renewal";
import { personBgOpen } from "@/lib/membership/lifecycle";
import { bgObligatedWhere, LIVE_PERSON } from "@/lib/person/filters";
import { systemActor } from "@/lib/auditActor";

/**
 * Triggers that OPEN a per-person background-check obligation (PERSON_BG process,
 * Phase 2 — warn-only). Two triggers, both keyed on the SAME "who needs a check"
 * rule as the compliance dashboard: personBgVerdict === "NEEDED" over
 * bgObligatedWhere (program-attached ∪ leads of ACTIVE member households — Trigger
 * A is a daily cron over all Persons, so that membership bound is what keeps it off
 * the leads of imports, abandoned intakes and denials). Deliberately NOT
 * triggered by role-assignment: age is judged as-of a boundary, so someone who
 * turns 18 mid-year is caught at the next annual run, not when they take a role.
 */


/**
 * Open one PERSON_BG obligation for `personId`, evaluated as of `asOf` (the annual
 * boundary for the cron, activation time for a new join; `threshold` is
 * bgFreshThreshold(asOf, bgRecheckMonths)). Idempotent + concurrency-safe: a FOR
 * UPDATE lock on the Person row serializes the check-then-insert (mirrors
 * createRenewalProcess in renewal.ts), so the daily cron and a near-cutoff
 * activation can't both open one.
 *
 * Dedup guards: (b) opens nothing unless personBgVerdict === "NEEDED" — which
 * already encodes "≥18 as of asOf AND not fresh" (FRESH/MINOR/DOB_MISSING all
 * skip); (a) opens nothing if a PERSON_BG is already in flight or blocked for this
 * person (BLOCKED is a manual-followup item, not something to auto-reopen nightly).
 * Returns the created process, or null when skipped.
 */
export async function openPersonBg(personId: number, asOf: Date, threshold: Date) {
    return prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Person" WHERE id = ${personId} FOR UPDATE`;
        const person = await tx.person.findUnique({
            where: { id: personId },
            select: { dateOfBirth: true, isDeclaredAdult: true, lastBackgroundCheck: true },
        });
        if (!person) return null;
        if (personBgVerdict(person, asOf, threshold) !== "NEEDED") return null; // (b)
        // The idempotency EXISTENCE set ("this person already owes a check → skip"),
        // shared with the person merge's duplicate resolution — one definition, since
        // the two must agree on what counts as open. Not `fromWhere`: this is broader
        // than any from-state (the PERSON_BG edge is ∅→PENDING_BG_REVIEW, no from-row).
        const existing = await tx.orgMembershipProcess.findFirst({
            where: { kind: "PERSON_BG", subjectPersonId: personId, ...personBgOpen.where },
            select: { id: true },
        });
        if (existing) return null; // (a)
        const created = await tx.orgMembershipProcess.create({
            data: { kind: "PERSON_BG", subjectPersonId: personId, orgMembershipId: null, status: "PENDING_BG_REVIEW" },
        });
        await tx.auditLog.create({
            data: {
                ...systemActor("system:person-bg-open"),
                action: "CREATE",
                tableName: "OrgMembershipProcess",
                affectedEntityId: created.id,
                newData: { kind: "PERSON_BG", status: "PENDING_BG_REVIEW", subjectPersonId: personId },
            },
        });
        return created;
    });
}

/**
 * Trigger A — annual cohort. For every check-obligated person NEEDED as of the
 * membership-year boundary, open a PERSON_BG. Idempotent: re-running opens none
 * (dedup guard), so the cron is safe to run daily. Skips entirely when the board
 * hasn't set bgRecheckMonths (policy unset) or has no membership-year boundary.
 */
export async function runPersonBgAnnualSweep(now: Date) {
    const settings = await prisma.boardSettings.findUnique({ where: { id: 1 } });
    const months = settings?.bgRecheckMonths ?? 0;
    if (months <= 0) return { opened: 0, reason: "bgRecheckMonths not configured" };
    if (!settings?.orgMembershipYearBoundary) return { opened: 0, reason: "no membership-year boundary configured" };

    const boundary = nextBoundary(settings.orgMembershipYearBoundary, now);
    const threshold = bgFreshThreshold(boundary, months);
    const people = await prisma.person.findMany({ where: { ...bgObligatedWhere(now), ...LIVE_PERSON }, select: { id: true } });

    let opened = 0;
    for (const p of people) {
        const created = await openPersonBg(p.id, boundary, threshold);
        if (created) opened++;
    }
    return { opened, boundary: boundary.toISOString() };
}

/**
 * Trigger C — new-member activation. When a brand-new membership (INITIAL) first
 * goes ACTIVE, open a PERSON_BG for each check-obligated person in that household
 * who is ≥18 as of activation and not fresh. Age is judged as-of `asOf` (join),
 * NOT the annual boundary — this is what catches a just-turned-18 joiner the
 * boundary run would still classify as a minor. The lead the INITIAL check named is
 * freshly stamped and skipped by the dedup guard; the lead it did not name is
 * exactly who this opens for. Population is bgObligatedWhere — the same set as
 * Trigger A / the dashboard (one source of "who needs a check"). No-op when
 * bgRecheckMonths is unset.
 */
export async function openPersonBgForNewMember(householdId: number, asOf: Date) {
    const settings = await prisma.boardSettings.findUnique({ where: { id: 1 } });
    const months = settings?.bgRecheckMonths ?? 0;
    if (months <= 0) return;
    const threshold = bgFreshThreshold(asOf, months);
    const people = await prisma.person.findMany({
        where: { householdId, ...bgObligatedWhere(asOf), ...LIVE_PERSON },
        select: { id: true },
    });
    for (const p of people) await openPersonBg(p.id, asOf, threshold);
}
