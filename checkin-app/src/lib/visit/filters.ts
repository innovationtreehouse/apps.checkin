import type { OrgMembershipStatus, Person, Prisma } from "@/generated/prisma/client";
import type { DbClient } from "@/lib/db-client";

/**
 * A live (non-tombstoned) Visit. A deleted visit keeps its row (deletedAt +
 * deletedById set) so the deletion is reviewable and reversible — so every
 * surface that lists, counts, or aggregates visits must filter through this.
 * Drift guard: src/__tests__/liveVisitDriftGuard.test.ts scans every
 * Visit-query site in src/app + src/lib and fails CI if a new one reads Visit
 * without this filter and isn't an explicitly justified exception.
 */
export const LIVE_VISIT: Prisma.VisitWhereInput = { deletedAt: null };

/** Household statuses whose keyholders hold no keyholder authority. */
export const KEYHOLDER_VOID_STATUSES: OrgMembershipStatus[] = ["DENIED", "REVOKED"];

/**
 * A keyholder: the one person filter every "is a keyholder in the building"
 * question uses. A denied household holds no authority and a revoked one has lost
 * its facility privileges, so neither's keyholder is one. Read on every query, so
 * a grant, revoke or denial takes effect on the next read: no visit is touched.
 * Drift guard:
 * src/__tests__/keyholderFilterDriftGuard.test.ts.
 */
export const LIVE_KEYHOLDER: Prisma.PersonWhereInput = {
    isKeyholder: true,
    NOT: { household: { orgMembership: { status: { in: KEYHOLDER_VOID_STATUSES } } } },
};

/** {@link LIVE_KEYHOLDER} applied to a person already read with its household's status. */
export function isLiveKeyholder(person: {
    isKeyholder?: boolean;
    household?: { orgMembership?: { status: OrgMembershipStatus } | null } | null;
}): boolean {
    const status = person.household?.orgMembership?.status;
    return !!person.isKeyholder && !(status && KEYHOLDER_VOID_STATUSES.includes(status));
}

/** Whether this person acts as a keyholder: flagged, and {@link LIVE_KEYHOLDER} holds now. */
export async function actsAsKeyholder(person: Pick<Person, "id" | "isKeyholder">, db: DbClient): Promise<boolean> {
    return person.isKeyholder && (await db.person.count({ where: { id: person.id, ...LIVE_KEYHOLDER } })) > 0;
}

/** An open, live visit by a keyholder: the building is open while one exists. */
export const KEYHOLDER_IN_BUILDING: Prisma.VisitWhereInput = { departedAt: null, ...LIVE_VISIT, person: LIVE_KEYHOLDER };
