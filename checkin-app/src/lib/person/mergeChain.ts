import prisma from "@/lib/prisma";
import type { Person } from "@/generated/prisma/client";

/** Real merges are one hop; the cap stops a corrupt or cyclic chain from looping the lookup. */
export const MAX_MERGE_HOPS = 5;

export type MergeResolution =
    /** `first` is the row the id itself names (null when only the archive knew it); `hops` counts merges followed. */
    | { kind: "live"; person: Person; first: Person | null; hops: number }
    /** The id names no Person and no archived merge. */
    | { kind: "unknown" }
    /** A merge pointer led into a gap or past the cap; `lastId` is the record it stopped at. */
    | { kind: "broken"; lastId: number };

/**
 * Follows an id to the live Person it names. A merged-away id presents two ways: its tombstone
 * row still exists (follow `mergedIntoId`), or the row is gone and only the PersonMerge archive
 * holds `fromId -> toId`. One loop covers both, since an archive's survivor may itself be a
 * tombstone. The archive is read before giving up on a missing row, so a deleted tombstone
 * still resolves.
 */
export async function resolveMergedPerson(id: number): Promise<MergeResolution> {
    const first = await prisma.person.findUnique({ where: { id } });
    let person = first;
    let lookupId = id;
    let hops = 0;
    while (person == null || person.mergedIntoId != null) {
        const pointer = person === null ? null : person.mergedIntoId;
        if (pointer === null) {
            const archived = await prisma.personMerge.findUnique({ where: { fromId: lookupId }, select: { toId: true } });
            if (!archived) return hops > 0 ? { kind: "broken", lastId: lookupId } : { kind: "unknown" };
            lookupId = archived.toId;
        } else {
            lookupId = pointer;
        }
        // Counted once the next id is known, so a capped chain names the record it stopped at
        // and that id is never fetched.
        hops++;
        if (hops > MAX_MERGE_HOPS) return { kind: "broken", lastId: lookupId };
        person = await prisma.person.findUnique({ where: { id: lookupId } });
    }
    return { kind: "live", person, first, hops };
}
