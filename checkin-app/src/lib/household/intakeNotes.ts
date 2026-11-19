const INTAKE_NOTE_KEYS = new Set(["intakeNotes", "intakeNoteSnapshot"]);

/**
 * A JSON snapshot (an audit row's oldData/newData) with every intake-note key
 * removed, at any depth. Audit rows written while the note existed still hold it.
 */
export function withoutIntakeNoteKeys(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(withoutIntakeNoteKeys);
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(
        Object.entries(value).filter(([key]) => !INTAKE_NOTE_KEYS.has(key)).map(([key, v]) => [key, withoutIntakeNoteKeys(v)]),
    );
}
