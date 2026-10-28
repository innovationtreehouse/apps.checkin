/**
 * Who may read a household's intake note: the Board, or a lead of that household
 * who wrote it. No other role qualifies (docs/rules/membership.md).
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

const INTAKE_NOTE_KEYS = new Set(["intakeNotes", "intakeNoteSnapshot"]);

/** A JSON snapshot (an audit row's oldData/newData) with every intake-note key removed, at any depth. */
export function withoutIntakeNoteKeys(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(withoutIntakeNoteKeys);
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(
        Object.entries(value).filter(([key]) => !INTAKE_NOTE_KEYS.has(key)).map(([key, v]) => [key, withoutIntakeNoteKeys(v)]),
    );
}
