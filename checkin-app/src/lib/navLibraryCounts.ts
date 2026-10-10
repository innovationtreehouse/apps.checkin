/**
 * Per-library nav pill counts for /api/nav/todo-counts. A library wiring PR
 * registers one provider in LIBRARY_COUNT_PROVIDERS; its counts reach the
 * client as `counts.libraries[library]`, read by badge functions via
 * navBadges' libraryCount().
 */
import type { SessionUser } from "@/types/auth";
import { isLibraryVisible, type LibraryKey } from "@/lib/libraryRelease";

export type LibraryCounts = Partial<Record<LibraryKey, Record<string, number>>>;

export type LibraryCountProvider = {
  library: LibraryKey;
  /** Whether this viewer may see the counts — mirror the library's read gate. */
  visible: (user: SessionUser) => boolean;
  /** Named counts for this viewer, e.g. { holds: 2, openFlags: 1 }. */
  count: (user: SessionUser) => Promise<Record<string, number>>;
};

/** Registered providers. Library wiring PRs append theirs here. */
export const LIBRARY_COUNT_PROVIDERS: LibraryCountProvider[] = [];

/**
 * Runs every provider the viewer may see, in parallel. A provider that throws
 * (e.g. its library DB is down) is logged and omitted, so it never breaks the
 * nav. Returns undefined when no provider produced counts.
 */
export async function collectLibraryCounts(
  user: SessionUser,
  releasedLibraries?: readonly string[] | null,
  providers: readonly LibraryCountProvider[] = LIBRARY_COUNT_PROVIDERS,
): Promise<LibraryCounts | undefined> {
  const viewer = { isBoardMember: user.isBoardMember, releasedLibraries };
  const results = await Promise.all(
    providers
      .filter((p) => isLibraryVisible(p.library, viewer) && p.visible(user))
      .map(async (p) => {
        try {
          return [p.library, await p.count(user)] as const;
        } catch (err) {
          console.error(`nav counts: ${p.library} provider failed`, err);
          return null;
        }
      }),
  );
  const libraries: LibraryCounts = {};
  for (const r of results) {
    if (r) libraries[r[0]] = { ...libraries[r[0]], ...r[1] };
  }
  return Object.keys(libraries).length > 0 ? libraries : undefined;
}
