type NamedEntity = {
    id: number;
    name: string | null;
    /** The name this person goes by; stands in for the first name when set. */
    nickname?: string | null;
    // Optional: some feeds (e.g. the certifications grid) resolve the email-prefix
    // fallback server-side and omit the raw address entirely.
    email?: string | null;
};

/** The last whitespace-separated word of a name, or "" when there isn't one. */
function finalWord(text: string): string {
    const parts = text.trim().split(/\s+/);
    return parts[parts.length - 1] || "";
}

/**
 * Parse a full name into a first name and the last name the display abbreviates.
 * Handles "First Last", "Last, First", and email-prefix fallback. A nickname
 * replaces the first name; the last name it disambiguates against still comes
 * from `name`, matching the badge labels (components/admin/badgeNames.ts).
 *
 * The last name is the FINAL word, so "John Frank Doe" is a John D. and a
 * multi-word surname abbreviates on its last word. Anything between the first and
 * last word is a middle name, which the display never shows.
 */
function parseName(entity: NamedEntity): { first: string; last: string } {
    const nickname = entity.nickname?.trim();
    const raw = entity.name?.trim();
    if (!raw) {
        // Fallback to email prefix when present (may be omitted — see NamedEntity).
        return { first: nickname || entity.email?.split("@")[0] || "", last: "" };
    }

    // Handle "Last, First" format
    if (raw.includes(",")) {
        const [lastPart, firstPart] = raw.split(",", 2);
        return {
            first: nickname || (firstPart || "").trim(),
            last: finalWord(lastPart || ""),
        };
    }

    // Standard "First Last" or single-word name
    const parts = raw.split(/\s+/);
    return {
        first: nickname || parts[0],
        last: parts.length > 1 ? parts[parts.length - 1] : "",
    };
}

/**
 * Build a map of participant ID → privacy-friendly display name.
 *
 * Rules:
 * 1. Show only the nickname, else only the first name, by default.
 * 2. If two people share that displayed name (case-insensitive),
 *    append the first initial of the last name (e.g. "Sarah M.").
 * 3. If that still isn't unique, append the first two characters
 *    of the last name (e.g. "Sarah Mo.", "Sarah Ma.").
 *
 * "Last name" throughout is the final word of the name — see parseName.
 */
export function getKioskDisplayNames(entities: NamedEntity[]): Map<number, string> {
    const parsed = entities.map((e) => ({
        id: e.id,
        ...parseName(e),
    }));

    // Group by lowercase first name
    const groups = new Map<string, typeof parsed>();
    for (const p of parsed) {
        const key = p.first.toLowerCase();
        const group = groups.get(key) || [];
        group.push(p);
        groups.set(key, group);
    }

    const result = new Map<number, string>();

    for (const group of groups.values()) {
        if (group.length === 1) {
            // Unique first name — no disambiguation needed
            result.set(group[0].id, group[0].first);
            continue;
        }

        // Multiple people share this first name — try 1-char last initial
        const byOneChar = new Map<string, typeof group>();
        for (const p of group) {
            const initial = p.last ? p.last[0].toUpperCase() : "";
            const key = initial;
            const bucket = byOneChar.get(key) || [];
            bucket.push(p);
            byOneChar.set(key, bucket);
        }

        for (const bucket of byOneChar.values()) {
            if (bucket.length === 1) {
                // 1-char initial is sufficient
                const p = bucket[0];
                const suffix = p.last ? ` ${p.last[0].toUpperCase()}.` : "";
                result.set(p.id, p.first + suffix);
            } else {
                // Still ambiguous — use 2-char prefix of last name
                for (const p of bucket) {
                    const prefix = p.last
                        ? p.last.slice(0, 2).charAt(0).toUpperCase() + p.last.slice(1, 2).toLowerCase()
                        : "";
                    const suffix = prefix ? ` ${prefix}.` : "";
                    result.set(p.id, p.first + suffix);
                }
            }
        }
    }

    return result;
}

/**
 * The same label for one person standing alone — the scan banner, which confirms a
 * single badge. Rules 2 and 3 cannot fire with nobody to collide with, so what this
 * resolves is the nickname-else-first-name-else-email-prefix part of the rule.
 */
export function getKioskDisplayName(entity: NamedEntity): string {
    return getKioskDisplayNames([entity]).get(entity.id) ?? "";
}
