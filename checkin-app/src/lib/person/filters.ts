import type { Prisma } from "@/generated/prisma/client";

/** An enrollment that still counts: a WITHDRAWN row is kept for history only. */
export const ENROLLED_PARTICIPANT: Prisma.ProgramParticipantWhereInput = { status: { not: "WITHDRAWN" } };

/**
 * A person whose email is sign-in-verified: they have a linked sign-in, which the
 * provider verified for that address, and member-side edits cannot change a linked
 * person's email. Only such a person counts as holding a volunteer-designated address.
 */
export const SIGN_IN_VERIFIED_PERSON: Prisma.PersonWhereInput = { accounts: { some: {} } };

/** The in-memory form of SIGN_IN_VERIFIED_PERSON, over a `_count.accounts` select. */
export function isSignInVerified(p: { _count: { accounts: number } }): boolean {
    return p._count.accounts > 0;
}

/** How far back a finished program still counts as "in the building". */
export const ATTACHMENT_LOOKBACK_MONTHS = 12;

/**
 * A program that is running, or ended within the lookback. Bounds "attached" by the
 * program's own window: attachment rows are never cleared when a program ends, so an
 * unbounded "any program ever" predicate would re-ask someone who took one class years
 * ago every cycle forever.
 */
export function recentProgramWhere(today: Date): Prisma.ProgramWhereInput {
    // startAt and endAt are calendar days, so `today` is the org's calendar day, not an instant.
    const since = new Date(today);
    since.setUTCMonth(since.getUTCMonth() - ATTACHMENT_LOOKBACK_MONTHS);
    return {
        AND: [
            { endAt: { gte: since } },
            { startAt: { lte: today } },
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
export function programAttachedWhere(today: Date): Prisma.PersonWhereInput {
    const program = recentProgramWhere(today);
    return {
        OR: [
            { programParticipants: { some: { program, ...ENROLLED_PARTICIPANT } } },
            { programVolunteers: { some: { program } } },
            { programsLed: { some: program } },
        ],
    };
}

/**
 * Person holding a position that needs a check of their own and that program attachment
 * does not already cover: a run leader, a bucket owner or treasurer of a live bucket, or
 * anyone with a role (the positions `positionHolders` lists). A run counts under the
 * same program window as the program arms.
 */
export function positionHeldWhere(today: Date): Prisma.PersonWhereInput {
    return {
        OR: [
            { instancesLed: { some: { program: recentProgramWhere(today) } } },
            { budgetOwnersOwned: { some: { archivedAt: null } } },
            { budgetOwnerTreasurerships: { some: { budgetOwner: { archivedAt: null } } } },
            { roles: { some: {} } },
        ],
    };
}

/**
 * Person who owes a background check of their own: program-attached, or holding a
 * position. Being a household lead adds nobody: a household needs one lead's check,
 * which its application decides.
 *
 * The board's compliance worklist reads it. The new-member PERSON_BG trigger opens for
 * the program-attached arm only.
 */
export function bgObligatedWhere(today: Date): Prisma.PersonWhereInput {
    return {
        household: { archivedAt: null },
        OR: [programAttachedWhere(today), positionHeldWhere(today)],
    };
}
