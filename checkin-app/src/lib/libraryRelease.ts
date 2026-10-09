export const LIBRARY_KEYS = [
  "catalog",
  "local-inventory",
  "expense",
  "income",
  "receipt",
  "bulk-donation",
  "workflow-mapping",
] as const;

export type LibraryKey = (typeof LIBRARY_KEYS)[number];

export const LIBRARY_LABELS: Record<LibraryKey, string> = {
  catalog: "Catalog",
  "local-inventory": "Local inventory",
  expense: "Expense",
  income: "Income",
  receipt: "Receipt",
  "bulk-donation": "Bulk donation",
  "workflow-mapping": "Workflow mapping",
};

export function isLibraryKey(value: unknown): value is LibraryKey {
  return typeof value === "string" && (LIBRARY_KEYS as readonly string[]).includes(value);
}

/**
 * UI-only pre-release gate: hides a library's nav entry points until the board
 * releases it (BoardSettings.releasedLibraries). Never enforces access — routes
 * keep their own role gates. Board members always see every library.
 */
export function isLibraryVisible(
  lib: LibraryKey,
  { isBoardMember, releasedLibraries }: { isBoardMember?: boolean; releasedLibraries?: readonly string[] | null },
): boolean {
  return !!isBoardMember || !!releasedLibraries?.includes(lib);
}
