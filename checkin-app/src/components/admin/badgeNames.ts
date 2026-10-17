// Pure badge-label helpers, split out of BadgeDocument so they can be unit-tested without
// pulling in @react-pdf/renderer (ESM, untransformed by jest).

// First name only, adding the minimum last-name prefix needed to disambiguate within this batch.
// A nickname stands in for the first name; the last name it disambiguates against still comes
// from `name`. Unique first name → first name alone. Collision → shortest prefix (1+ chars) that
// no other same-first-name badge shares; a partial prefix gets a trailing "." (e.g. "John S.",
// "John Sm."). True duplicates (identical full name) fall back to the full last name.
export function computeDisplayNames(badges: { id: number; name: string; nickname?: string | null }[]): Map<number, string> {
    // The last name is the FINAL word, so "John Frank Doe" is a John D. and a
    // multi-word surname abbreviates on its last word. Anything between the first
    // and last word is a middle name, which a badge never shows.
    const parse = (full: string, nickname?: string | null) => {
        const parts = (full || '').trim().split(/\s+/);
        return { first: (nickname || '').trim() || parts[0] || '', last: parts.length > 1 ? parts[parts.length - 1] : '' };
    };
    const parsed = badges.map(b => ({ id: b.id, ...parse(b.name, b.nickname) }));
    const groups = new Map<string, typeof parsed>();
    for (const p of parsed) {
        const key = p.first.toLowerCase();
        (groups.get(key) ?? groups.set(key, []).get(key)!).push(p);
    }
    const result = new Map<number, string>();
    for (const group of groups.values()) {
        for (const p of group) {
            if (group.length === 1 || !p.last) {
                result.set(p.id, p.first || `User #${p.id}`);
                continue;
            }
            const others = group.filter(o => o !== p);
            let len = 1;
            while (len < p.last.length &&
                others.some(o => o.last.slice(0, len).toLowerCase() === p.last.slice(0, len).toLowerCase())) {
                len++;
            }
            const prefix = p.last.slice(0, len);
            const abbreviated = prefix.length < p.last.length;
            result.set(p.id, `${p.first} ${prefix}${abbreviated ? '.' : ''}`);
        }
    }
    return result;
}
