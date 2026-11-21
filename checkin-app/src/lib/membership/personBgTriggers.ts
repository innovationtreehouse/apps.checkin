import prisma from "@/lib/prisma";
import { bgFreshThreshold, personBgVerdict } from "@/lib/membership/personBgCheck";
import { isRecheckPolicySet } from "@/lib/membership/bgRecheckPolicy";
import { personBgOpen } from "@/lib/membership/lifecycle";
import { programAttachedWhere } from "@/lib/person/filters";
import { checkValidForApplication } from "@/lib/membership/checkStanding";
import { systemActor } from "@/lib/auditActor";

/**
 * Open one PERSON_BG obligation for `personId`, evaluated as of `asOf` against
 * `threshold`, the earliest check date that still counts. Idempotent +
 * concurrency-safe: a FOR UPDATE lock on the Person row serializes the
 * check-then-insert (mirrors createRenewalProcess in renewal.ts), so two
 * activations racing can't both open one.
 *
 * Dedup guards: (b) opens nothing unless personBgVerdict === "NEEDED" — which
 * already encodes "≥18 as of asOf AND not fresh" (FRESH/MINOR/DOB_MISSING all
 * skip); (a) opens nothing if a PERSON_BG is already in flight or blocked for this
 * person (BLOCKED is a manual-followup item, not something to auto-reopen).
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
    }, { maxWait: 5_000, timeout: 15_000 });
}

/**
 * New-member activation. When a brand-new membership (INITIAL) first goes ACTIVE,
 * open a PERSON_BG for each program-attached person in that household who is ≥18 as
 * of activation and whose check is not valid at the start of the membership year the
 * join paid for (activation minus the interval when no boundary is set). Household
 * leads are not opened for as leads: the household needs one lead's check, which its
 * own application already decided. A lead who is also program-attached is still
 * opened for. No-op when bgRecheckMonths is unset.
 */
export async function openPersonBgForNewMember(householdId: number, asOf: Date) {
    const settings = await prisma.boardSettings.findUnique({ where: { id: 1 } });
    const months = settings?.bgRecheckMonths;
    if (!isRecheckPolicySet(months)) return;
    const activated = await prisma.orgMembershipProcess.findFirst({
        where: { orgMembership: { householdId }, kind: "INITIAL", status: "ACTIVE" },
        orderBy: { id: "desc" },
        select: { appliesToYear: true },
    });
    const threshold = (await checkValidForApplication({ appliesToYear: activated?.appliesToYear ?? null, createdAt: asOf })) ?? bgFreshThreshold(asOf, months);
    const people = await prisma.person.findMany({
        where: { householdId, household: { archivedAt: null }, ...programAttachedWhere(asOf) },
        select: { id: true },
    });
    for (const p of people) await openPersonBg(p.id, asOf, threshold);
}
