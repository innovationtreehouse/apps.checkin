import prisma from "@/lib/prisma";
import type { Person } from "@/generated/prisma/client";
import { MAX_MERGE_HOPS } from "@/lib/person/filters";

export { MAX_MERGE_HOPS };

export type MergeResolution =
    /** `first` is the row the id itself names (null when only the archive knew it); `hops` counts merges followed. */
    | { kind: "live"; person: Person; first: Person | null; hops: number }
    /** The id names no Person and no archived merge. */
    | { kind: "unknown" }
    /** A merge pointer led into a gap or past the cap; `lastId` is the record it stopped at. */
    | { kind: "broken"; lastId: number };

/** One id the walk looked up, with its Person row (null when no row exists for that id). */
export type MergeChainStep = { id: number; person: Person | null };

/**
 * Follows an id to the live Person it names. A merged-away id presents two ways: its tombstone
 * row still exists (follow `mergedIntoId`), or the row is gone and only the PersonMerge archive
 * holds `fromId -> toId`. One loop covers both, since an archive's survivor may itself be a
 * tombstone. The archive is read before giving up on a missing row, so a deleted tombstone
 * still resolves. `chain` lists every id looked up, in order, starting with `id`.
 */
export async function walkMergeChain(id: number): Promise<{ resolution: MergeResolution; chain: MergeChainStep[] }> {
    const first = await prisma.person.findUnique({ where: { id } });
    const chain: MergeChainStep[] = [{ id, person: first }];
    let person = first;
    let lookupId = id;
    let hops = 0;
    while (person == null || person.mergedIntoId != null) {
        const pointer = person === null ? null : person.mergedIntoId;
        if (pointer === null) {
            const archived = await prisma.personMerge.findUnique({ where: { fromId: lookupId }, select: { toId: true } });
            if (!archived) return { resolution: hops > 0 ? { kind: "broken", lastId: lookupId } : { kind: "unknown" }, chain };
            lookupId = archived.toId;
        } else {
            lookupId = pointer;
        }
        // Counted once the next id is known, so a capped chain names the record it stopped at
        // and that id is never fetched.
        hops++;
        if (hops > MAX_MERGE_HOPS) return { resolution: { kind: "broken", lastId: lookupId }, chain };
        person = await prisma.person.findUnique({ where: { id: lookupId } });
        chain.push({ id: lookupId, person });
    }
    return { resolution: { kind: "live", person, first, hops }, chain };
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
