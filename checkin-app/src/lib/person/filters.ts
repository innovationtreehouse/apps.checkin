import type { Prisma } from "@/generated/prisma/client";

/**
 * A live (non-tombstoned) Person. A merged-away record keeps its rows for audit
 * (mergedIntoId set, never deleted), so every surface that must NOT show or count a
 * tombstone — search, rosters, enrollment counts, RSVP/cert lists, the match audit —
 * filters through this. Drift guard: src/__tests__/livePersonDriftGuard.test.ts scans
 * every Person-query site in src/app + src/lib and fails CI if a new one reads Person
 * without this filter and isn't an explicitly justified exception (sweep/reconciler,
 * historical record, etc).
 */
export const LIVE_PERSON: Prisma.PersonWhereInput = { mergedIntoId: null };

/** How far back a finished program still counts as "in the building". */
export const ATTACHMENT_LOOKBACK_MONTHS = 12;

/**
 * A program that is running, or ended within the lookback. Bounds "attached" by the
 * program's own window: attachment rows are never cleared when a program ends, so an
 * unbounded "any program ever" predicate would re-ask someone who took one class years
 * ago every cycle forever.
 */
export function recentProgramWhere(now: Date): Prisma.ProgramWhereInput {
    const since = new Date(now);
    since.setUTCMonth(since.getUTCMonth() - ATTACHMENT_LOOKBACK_MONTHS);
    return {
        AND: [
            { endAt: { gte: since } },
            { startAt: { lte: now } },
        ],
    };
}

/**
 * Person is attached to at least one program (in any of the three roles) whose window is
 * current or ended within the lookback — the shared "who is in the building" population
 * behind the PERSON_BG and PERSON_AGREEMENT obligations and the board compliance lists.
 *
 * Lives here rather than in either trigger module: both need it, and importing one
 * trigger from the other closes an import cycle (personBgTriggers → renewal → payment →
 * personAgreementTriggers → personBgTriggers) that fails at module init with a TDZ error.
 */
export function programAttachedWhere(now: Date): Prisma.PersonWhereInput {
    const program = recentProgramWhere(now);
    return {
        OR: [
            { programParticipants: { some: { program } } },
            { programVolunteers: { some: { program } } },
            { programsLed: { some: program } },
        ],
    };
}

/**
 * Person who owes a background check of their own: program-attached, or a signing
 * adult of an ACTIVE member household. Clearing a household review stamps only the one
 * adult its reviewers named, so without the lead arm the other signing adult — the
 * parent who signs and drops off, attached to no program — is on no track at all.
 *
 * The ACTIVE bound is load-bearing, not decoration. `isHouseholdLead` marks the lead of
 * EVERY household the app creates: imported legacy, program-only, abandoned intakes
 * (startIntake anchors a membership at status NONE), DENIED and REVOKED. A bare lead arm
 * would open a PERSON_BG on the daily cron for people who never became members. Mirrors
 * the agreement track's autoPopulationWhere, and matches the rule the obligation states
 * ("activating a membership opens...").
 *
 * The PERSON_BG openers and the board's compliance worklist share it, so what the
 * triggers open is what the board can act on.
 */
export function bgObligatedWhere(now: Date): Prisma.PersonWhereInput {
    return {
        OR: [programAttachedWhere(now), { isHouseholdLead: true, household: { orgMembership: { status: "ACTIVE" } } }],
    };
}
