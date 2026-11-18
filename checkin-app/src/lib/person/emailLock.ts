import type { Prisma } from "@/generated/prisma/client";

/**
 * The relations that decide whether a member's email is locked. A Person `include`
 * (scalars come with it) or merged into a `select` alongside `lastBackgroundCheck`
 * and `canAccessStaging`.
 */
export const EMAIL_LOCK_RELATIONS = {
    _count: {
        select: {
            accounts: true,
            roles: true,
            programsLed: true,
            programVolunteers: true,
            bgAttestationsAsSubject: true,
            personBgProcesses: true,
            toolStatuses: true,
        },
    },
    budgetOwnersOwned: { select: { id: true }, take: 1 },
    budgetOwnerTreasurerships: { select: { budgetOwnerId: true }, take: 1 },
    instancesLed: { select: { id: true }, take: 1 },
    household: { select: { orgMembership: { select: { isVolunteerFamily: true } } } },
} satisfies Prisma.PersonInclude;

export const EMAIL_LOCK_SELECT = {
    ...EMAIL_LOCK_RELATIONS,
    lastBackgroundCheck: true,
    canAccessStaging: true,
} satisfies Prisma.PersonSelect;

export type EmailLockFields = Prisma.PersonGetPayload<{ select: typeof EMAIL_LOCK_SELECT }>;

/**
 * Board-granted authority, a recorded background check, staging access or a
 * Volunteer Family household: the email is the address that authority was granted to.
 */
export function holdsEmailGrant(p: EmailLockFields): boolean {
    const c = p._count;
    return c.roles + c.programsLed + c.programVolunteers + c.bgAttestationsAsSubject + c.personBgProcesses + c.toolStatuses > 0
        || p.budgetOwnersOwned.length + p.budgetOwnerTreasurerships.length + p.instancesLed.length > 0
        || Boolean(p.lastBackgroundCheck)
        || p.canAccessStaging
        || Boolean(p.household?.orgMembership?.isVolunteerFamily);
}

/** Whether the household member edit refuses a change to this member's email. */
export function isEmailLocked(p: EmailLockFields): boolean {
    return p._count.accounts > 0 || holdsEmailGrant(p);
}
