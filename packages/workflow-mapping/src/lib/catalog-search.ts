export const MIN_CATALOG_SEARCH_LENGTH = 2;

/** The text to send to the catalog search, or null while it is too short to search. */
export function catalogSearchTerm(q: string): string | null {
  const term = q.trim();
  return term.length < MIN_CATALOG_SEARCH_LENGTH ? null : term;
}
