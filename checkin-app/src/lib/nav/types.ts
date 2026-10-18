/**
 * Shared shapes for the client nav. A section descriptor (lib/nav/sections/*) is
 * the one place a section's "who can see this" gate is written; AppFrame, the
 * section layout and the /index directory all read it.
 */
import type { TodoCounts } from "@/lib/nav/todoCounts";
import type { NavBadge } from "@/components/navBadges";
import type { LibraryKey } from "@/lib/libraryRelease";
import type { VolunteerClaims } from "@/lib/volunteer";

/** A tab or page link as the host renders it. Library packages' nav links have this shape. */
export interface NavLink {
  name: string;
  href: string;
  icon?: string;
}

/** The session claims a nav gate reads; the NextAuth session user satisfies it. */
export type NavUser = VolunteerClaims & {
  householdLead?: boolean;
  toolStatuses?: Array<{ level: string }>;
};

/** A client display gate. `counts` carries computed roles (leads a program) and the library release list. */
export type NavGate = (user: NavUser | undefined, counts: TodoCounts | null) => boolean;

export interface SectionLink extends NavLink {
  /** Set only where this page's gate is stricter or looser than its section's. */
  visible?: NavGate;
  /** The library that owns the page; it stays hidden until the board releases that library. */
  library?: LibraryKey;
  /** The tab's pill; null hides it. */
  badge?: (counts: TodoCounts | null) => NavBadge | null;
}

export interface NavSection {
  id: string;
  /** Sidebar label. */
  label: string;
  /** Sidebar target; its badges key off this href. */
  href: string;
  links: readonly SectionLink[];
  /** Who the section admits. A section with links shows in the sidebar only while one of them is visible. */
  visible: NavGate;
  /** Per-viewer sidebar destination, when the default lands on a tab the viewer cannot open. */
  hrefFor?: (user: NavUser | undefined, counts: TodoCounts | null) => string;
}
