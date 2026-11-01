// The one place a receipt's stored person ids become people. A merge cannot rewrite ids in this
// database, so a read that skips this shows the survivor nothing and clears a conflicted approver.
import { ports } from "../runtime";

/** The live person each id names, deduplicated for the host; null for an id that names nobody live. */
export async function liveIds(personIds: number[]): Promise<Map<number, number | null>> {
  if (personIds.length === 0) return new Map();
  return ports().personIds.liveIds([...new Set(personIds)]);
}

const PERSON_COLUMNS = ["uploadedByUserId", "reimburseePersonId", "reviewedByUserId"] as const;
type PersonColumns = { [C in (typeof PERSON_COLUMNS)[number]]?: number | null };

/**
 * The rows with each person column naming the live person. An id naming nobody live stays as
 * stored: it matches no caller, and the conflict check refuses it by asking `liveIds` itself.
 */
export async function withLivePeople<T extends PersonColumns>(rows: T[]): Promise<T[]> {
  const live = await liveIds(rows.flatMap((row) => PERSON_COLUMNS.flatMap((column) => row[column] ?? [])));
  return rows.map((row) => {
    const resolved = { ...row };
    for (const column of PERSON_COLUMNS) {
      const id = row[column];
      if (id != null) (resolved as PersonColumns)[column] = live.get(id) ?? id;
    }
    return resolved;
  });
}
