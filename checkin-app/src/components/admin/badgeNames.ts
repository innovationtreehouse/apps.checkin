// Pure badge-label helpers, split out of BadgeDocument so they can be unit-tested without
// pulling in @react-pdf/renderer (ESM, untransformed by jest).
import { displayNames } from "@/lib/person/name";

// The name each person goes by, adding the minimum surname needed to disambiguate within this
// batch: "John S.", "John Sm.", "Maria De La C.". A suffix tells apart names that differ only by
// it ("John S. Jr."); identical names print the whole surname.
export function computeDisplayNames(badges: { id: number; name: string; nickname?: string | null }[]): Map<number, string> {
    return displayNames(badges, { fallback: (b) => `User #${b.id}` });
}
