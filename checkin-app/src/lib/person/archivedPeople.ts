import type { DbClient } from "@/lib/db-client";

/** A merged-away person as the merge archive remembers them; `mergedIntoId` is the survivor. */
export type ArchivedPerson = { id: number; name: string | null; mergedIntoId: number };

function snapshotName(snapshot: unknown): string | null {
    if (typeof snapshot !== "object" || snapshot === null) return null;
    const name = (snapshot as Record<string, unknown>).name;
    return typeof name === "string" ? name : null;
}

/**
 * The merged-away people among `ids`, read from the PersonMerge archive: a merge
 * deletes the Person row, so a historical record that names a person by a bare
 * id (an audit actor, a payment exception) finds them here. An id with no
 * archive row is absent from the result.
 */
export async function archivedPeople(db: DbClient, ids: number[]): Promise<ArchivedPerson[]> {
    if (ids.length === 0) return [];
    const rows = await db.personMerge.findMany({
        where: { fromId: { in: ids } },
        select: { fromId: true, toId: true, snapshot: true },
    });
    return rows.map((r) => ({ id: r.fromId, name: snapshotName(r.snapshot), mergedIntoId: r.toId }));
}

/** Whether any of `ids` names a person a merge has archived and deleted. */
export async function anyMergedAway(db: DbClient, ids: number[]): Promise<boolean> {
    return (await db.personMerge.count({ where: { fromId: { in: ids } } })) > 0;
}

/** Names for `ids`, from the Person row or, for a merged-away person, the archive. */
export async function personNamesById(db: DbClient, ids: number[]): Promise<Map<number, string | null>> {
    if (ids.length === 0) return new Map();
    const people = await db.person.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
    const names = new Map<number, string | null>(people.map((p) => [p.id, p.name]));
    for (const archived of await archivedPeople(db, ids.filter((id) => !names.has(id)))) {
        names.set(archived.id, archived.name);
    }
    return names;
}
