import type { RoleFlag } from "@/lib/roles";
import { isLibraryVisible } from "@/lib/libraryRelease";
import type { TodoCounts } from "@/lib/nav/todoCounts";
import type { NavGate, NavSection, NavUser, SectionLink, SubLink } from "@/lib/nav/types";

/** True when the user holds one of `roles`. A flag counts only when it is exactly `true`. */
export const hasAnyRole = (
  user: Partial<Record<RoleFlag, boolean>> | undefined,
  roles: readonly RoleFlag[],
): boolean => roles.some((r) => user?.[r] === true);

export const SYSADMIN_OR_BOARD = ["isSysadmin", "isBoardMember"] as const satisfies readonly RoleFlag[];
/** The finance areas admit FINANCE or BOARD; sysadmin has no access (docs/rules/revenue.md). */
export const FINANCE_OR_BOARD = ["isFinance", "isBoardMember"] as const satisfies readonly RoleFlag[];

export const everyone: NavGate = () => true;
export const signedIn: NavGate = (u) => !!u;
export const anyRole = (roles: readonly RoleFlag[]): NavGate => (u) => hasAnyRole(u, roles);

/** The link's own gate, else its section's. Ignores library release. */
export function linkAllowed(section: NavSection, link: SectionLink, user: NavUser | undefined, counts: TodoCounts | null): boolean {
  return (link.visible ?? section.visible)(user, counts);
}

function released(link: SubLink, user: NavUser | undefined, counts: TodoCounts | null): boolean {
  return !link.library || isLibraryVisible(link.library, { isBoardMember: user?.isBoardMember, releasedLibraries: counts?.releasedLibraries });
}

/** A sub-link's own check under an admitted group: its gate, else the group's, else the section's; and its library released. */
function subLinkAllowed(section: NavSection, group: SectionLink, sub: SubLink, user: NavUser | undefined, counts: TodoCounts | null): boolean {
  return (sub.visible ?? group.visible ?? section.visible)(user, counts) && released(sub, user, counts);
}

/** Every page a tab owns: its own href and its sub-links'. */
export function tabHrefs(link: SectionLink): string[] {
  return [link.href, ...(link.subLinks ?? []).map((s) => s.href)];
}

/**
 * The section's links this viewer may open: allowed, and their library released.
 * A grouped tab keeps only its visible sub-links, opens the first, and hides when none is left.
 */
export function visibleLinks(section: NavSection, user: NavUser | undefined, counts: TodoCounts | null): SectionLink[] {
  return section.links.flatMap((l) => {
    if (!linkAllowed(section, l, user, counts) || !released(l, user, counts)) return [];
    if (!l.subLinks) return [l];
    const subLinks = l.subLinks.filter((s) => subLinkAllowed(section, l, s, user, counts));
    return subLinks.length > 0 ? [{ ...l, href: subLinks[0].href, subLinks }] : [];
  });
}

/** Whether the section's sidebar entry shows: admitted, and a tab to open if it has tabs. */
export function sectionShown(section: NavSection, user: NavUser | undefined, counts: TodoCounts | null): boolean {
  return section.visible(user, counts) && (section.links.length === 0 || visibleLinks(section, user, counts).length > 0);
}

/**
 * The gate of one of the section's links, library release included. A sub-link's
 * href resolves to that sub-link under its group, ahead of a group sharing the href.
 */
export function linkGate(section: NavSection, href: string): NavGate {
  const group = section.links.find((l) => l.subLinks?.some((s) => s.href === href));
  const sub = group?.subLinks?.find((s) => s.href === href);
  if (group && sub) {
    return (u, c) => linkAllowed(section, group, u, c) && released(group, u, c) && subLinkAllowed(section, group, sub, u, c);
  }
  const link = section.links.find((l) => l.href === href);
  if (!link) throw new Error(`${href} is not a ${section.id} link`);
  return (u, c) => linkAllowed(section, link, u, c) && released(link, u, c);
}

/** The first tab this viewer may open, else the section's own href. */
export function firstVisibleHref(section: NavSection, user: NavUser | undefined, counts: TodoCounts | null): string {
  return visibleLinks(section, user, counts)[0]?.href ?? section.href;
}
