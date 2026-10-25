import { displayNames } from "@/lib/person/name";

type NamedEntity = {
    id: number;
    name: string | null;
    /** The name this person goes by; stands in for the first name when set. */
    nickname?: string | null;
    // Optional: some feeds (e.g. the certifications grid) resolve the email-prefix
    // fallback server-side and omit the raw address entirely.
    email?: string | null;
};

/**
 * Build a map of participant ID → privacy-friendly display name: the name each person
 * goes by, and — only where two share it — at most two letters of the surname
 * ("Sarah M.", "Sarah Mo.", "Maria De La C."). The parsing and the cut are the badge's
 * own (lib/person/name.ts); the two-letter cap is the kiosk's. Someone with no name
 * shows the part of their email before the @.
 */
export function getKioskDisplayNames(entities: NamedEntity[]): Map<number, string> {
    return displayNames(entities, { maxLetters: 2, fallback: (e) => e.email?.split("@")[0] ?? "" });
}

/**
 * The same label for one person standing alone — the scan banner, which confirms a
 * single badge. With nobody to collide with, no surname is added, so what this
 * resolves is the nickname-else-first-name-else-email-prefix part of the rule.
 */
export function getKioskDisplayName(entity: NamedEntity): string {
    return getKioskDisplayNames([entity]).get(entity.id) ?? "";
}
