/**
 * The row id a search query names, or null when the query is not a bare id.
 *
 * Every ops search box accepts an id as well as text, because the tables behind
 * them print the id column and operators paste one back in. Bounded to Postgres
 * int4: a larger literal would make Prisma throw on the query instead of simply
 * matching nothing, and would never be a real id anyway.
 */
export function searchId(query: string): number | null {
    const trimmed = query.trim();
    if (!/^\d+$/.test(trimmed)) return null;
    const id = Number(trimmed);
    return id <= 2147483647 ? id : null;
}

/**
 * A predicate for whether a person row matches what was typed in a search box —
 * name, email, or a bare id. The client-side twin of the OR the people-search
 * routes build, for the lists that filter in the browser.
 *
 * Built once per query rather than once per row: the lowered query and the parsed
 * id are the same for every row, so filtering a long list parses the query once.
 * Omit a field the caller doesn't hold and it simply doesn't match on it.
 */
export function personQueryMatcher(query: string) {
    const q = query.trim().toLowerCase();
    const id = searchId(query);
    return (person: { id: number; name?: string | null; email?: string | null }) =>
        !q
        || (person.name || '').toLowerCase().includes(q)
        || (person.email || '').toLowerCase().includes(q)
        || person.id === id;
}

/**
 * The household twin: its name — or whatever the caller shows in place of one —
 * and its own id. Keeps the household-id rule in the same place as the person one,
 * so the two can't drift.
 */
export function householdQueryMatcher(query: string) {
    const q = query.trim().toLowerCase();
    const id = searchId(query);
    return (household: { id: number; name?: string | null }) =>
        !q || (household.name || '').toLowerCase().includes(q) || household.id === id;
}
