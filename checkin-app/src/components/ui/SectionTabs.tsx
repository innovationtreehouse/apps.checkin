"use client";

import { usePathname, useRouter } from "next/navigation";
import { Tabs } from "@mantine/core";
import { ScrollableTabsList } from "@/components/ui/ScrollableTabsList";
import { useConfirmNav } from "@/components/UnsavedChangesProvider";
import { tabHrefs } from "@/lib/nav/gates";
import type { SectionLink } from "@/lib/nav/types";

/**
 * The one shared section-tab bar. Owns the active-tab computation, the single
 * guarded onChange, and per-tab rendering, so no layout can forget confirmNav
 * or the self-check.
 *
 * Auth/loading gates stay in each layout (different hooks, different copy).
 */
interface SectionTabsProps {
  links: readonly SectionLink[];
  /** Match sub-routes (/foo/123) to their parent tab via longest-prefix. Default: exact match. */
  prefixMatch?: boolean;
  /** Optional right-aligned content (e.g. a count badge) for a given tab href. */
  badgeFor?: (href: string) => React.ReactNode;
  /** Mantine bottom margin. Omit inside a <Stack> that already provides the gap. */
  mb?: string;
  /** Mantine tab style; a sub-tab row uses "pills" to sit apart from the section row. */
  variant?: "default" | "pills";
}

/** The tab owning `pathname`: the longest matching href, a tab's sub-links included. */
export function activeTab<T extends SectionLink>(links: readonly T[], pathname: string, prefixMatch = false): T | undefined {
  const hit = (href: string) => pathname === href || (prefixMatch && pathname.startsWith(`${href}/`));
  let best: T | undefined;
  let bestLength = -1;
  for (const link of links) {
    for (const href of tabHrefs(link)) {
      if (hit(href) && href.length > bestLength) {
        best = link;
        bestLength = href.length;
      }
    }
  }
  return best;
}

export function SectionTabs({ links, prefixMatch = false, badgeFor, mb, variant }: SectionTabsProps) {
  const pathname = usePathname();
  const router = useRouter();
  const confirmNav = useConfirmNav();

  const active = activeTab(links, pathname, prefixMatch)?.href ?? null;

  return (
    <Tabs
      value={active}
      onChange={(value) => {
        if (value && value !== active && confirmNav()) router.push(value);
      }}
      mb={mb}
      variant={variant}
    >
      <ScrollableTabsList>
        {links.map((link) => (
          <Tabs.Tab
            key={link.href}
            value={link.href}
            leftSection={link.icon ? <span>{link.icon}</span> : undefined}
            rightSection={badgeFor?.(link.href)}
          >
            {link.name}
          </Tabs.Tab>
        ))}
      </ScrollableTabsList>
    </Tabs>
  );
}
