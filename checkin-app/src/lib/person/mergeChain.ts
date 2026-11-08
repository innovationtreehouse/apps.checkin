import prisma from "@/lib/prisma";
import type { Person } from "@/generated/prisma/client";

export type MergeResolution =
    /** `hops` counts merges followed. */
    | { kind: "live"; person: Person; hops: number }
    /** The id names no Person and no archived merge. */
    | { kind: "unknown" }
    /** The archive names a survivor with no Person row; `lastId` is that survivor's id. */
    | { kind: "broken"; lastId: number };

/** One id the walk looked up, with its Person row (null when no row exists for that id). */
export type MergeChainStep = { id: number; person: Person | null };

/**
 * Follows an id to the live Person it names. A merged-away id has no Person row; the PersonMerge
 * archive holds `fromId -> toId`, and `toId` is a foreign key that a later merge repoints, so the
 * archive is one hop. A survivor missing when it is read means a merge or delete raced this one.
 * `chain` lists every id looked up, in order, starting with `id`.
 */
export async function walkMergeChain(id: number): Promise<{ resolution: MergeResolution; chain: MergeChainStep[] }> {
    const person = await prisma.person.findUnique({ where: { id } });
    const chain: MergeChainStep[] = [{ id, person }];
    if (person) return { resolution: { kind: "live", person, hops: 0 }, chain };
    const archived = await prisma.personMerge.findUnique({ where: { fromId: id }, select: { toId: true } });
    if (!archived) return { resolution: { kind: "unknown" }, chain };
    const survivor = await prisma.person.findUnique({ where: { id: archived.toId } });
    chain.push({ id: archived.toId, person: survivor });
    if (!survivor) return { resolution: { kind: "broken", lastId: archived.toId }, chain };
    return { resolution: { kind: "live", person: survivor, hops: 1 }, chain };
}

/** The ids merged into this person; a merge repoints older archive rows, so each names its final survivor. */
export async function mergedAwayIdsOf(id: number): Promise<number[]> {
    const rows = await prisma.personMerge.findMany({ where: { toId: id }, select: { fromId: true } });
    return rows.map((r) => r.fromId);
}

/** The live Person an id resolves to; see walkMergeChain. */
export async function resolveMergedPerson(id: number): Promise<MergeResolution> {
    return (await walkMergeChain(id)).resolution;
}

/** Who each stored id names today, null for nobody. One query when nobody was merged; only the missing ids walk the merge archive. */
export async function liveIdsOf(personIds: number[]): Promise<Map<number, number | null>> {
    const live = await prisma.person.findMany({ where: { id: { in: personIds } }, select: { id: true } });
    const out = new Map<number, number | null>(live.map(({ id }) => [id, id]));
    for (const id of personIds) {
        if (out.has(id)) continue;
        const resolved = await resolveMergedPerson(id);
        out.set(id, resolved.kind === "live" ? resolved.person.id : null);
    }
    return out;
}

/** Every id a library row may hold for a live person: their own and each id merged into them. */
export async function storedIdsOf(personId: number): Promise<number[]> {
    return [personId, ...(await mergedAwayIdsOf(personId))];
}
