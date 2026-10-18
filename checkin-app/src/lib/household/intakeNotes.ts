/**
 * Who may read a household's intake note on a household-management route: a
 * lead of that household, or the Board. The sysadmin role never qualifies on
 * its own (docs/rules/membership.md); reviewers read it through their queue.
 */
export function canSeeIntakeNotes(
    user: { isBoardMember?: boolean | null; householdId?: number | null; householdLead?: boolean | null },
    householdId: number,
): boolean {
    return Boolean(user.isBoardMember || (user.householdLead && user.householdId === householdId));
}

/** The household with its intake note nulled unless `user` may read it. */
export function withIntakeNotesFor<T extends { id: number; intakeNotes: string | null }>(
    household: T,
    user: Parameters<typeof canSeeIntakeNotes>[0],
): T {
    return canSeeIntakeNotes(user, household.id) ? household : { ...household, intakeNotes: null };
}
