import type { DbClient } from "@/lib/db-client";
import { ServiceError } from "@checkin/component-kit";

export const ARCHIVED_HOUSEHOLD_REFUSAL = "This household is archived, so nothing about it can change. The Board can unarchive it.";

/** A write would change an archived household, one of its members, or their roles or enrollments. */
export class ArchivedHouseholdError extends ServiceError {
    constructor() {
        super(409, ARCHIVED_HOUSEHOLD_REFUSAL, "household_archived");
    }
}

/**
 * Locks the households FOR UPDATE, in id order, and throws ArchivedHouseholdError
 * when one is archived. Archiving takes the same lock, so a write that calls this
 * in its transaction, before it writes, either commits before an archive reads the
 * household or is refused once it is archived. Take it after any OrgMembership or
 * application lock the transaction holds: archiving takes those first.
 */
export async function lockLiveHouseholds(db: DbClient, householdIds: readonly number[]): Promise<void> {
    for (const id of [...new Set(householdIds)].sort((a, b) => a - b)) {
        // Row security hides an archived row, so a missing row is an archived one.
        // A connection row security does not bind sees the row, and archivedAt says so.
        const [row] = await db.$queryRaw<{ archivedAt: Date | null }[]>`SELECT "archivedAt" FROM "Household" WHERE id = ${id} FOR UPDATE`;
        if (!row || row.archivedAt) throw new ArchivedHouseholdError();
    }
}

/** {@link lockLiveHouseholds} for the households these people are in. A person moved meanwhile is refused. */
export async function lockLiveHouseholdsOf(db: DbClient, personIds: readonly number[]): Promise<void> {
    const where = { id: { in: [...personIds] } };
    const before = await db.person.findMany({ where, select: { id: true, householdId: true } });
    await lockLiveHouseholds(db, before.map((p) => p.householdId));
    const after = await db.person.findMany({ where, select: { id: true, householdId: true } });
    if (after.some((p) => before.find((b) => b.id === p.id)?.householdId !== p.householdId)) {
        throw new ServiceError(409, "Someone here moved household while you were working. Reload and try again.");
    }
}
