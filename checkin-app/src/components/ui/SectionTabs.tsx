"use client";

import { usePathname, useRouter } from "next/navigation";
import { Tabs } from "@mantine/core";
import { ScrollableTabsList } from "@/components/ui/ScrollableTabsList";
import { useConfirmNav } from "@/components/UnsavedChangesProvider";
import type { NavLink } from "@/lib/nav/types";

/**
 * The one shared section-tab bar. Owns the active-tab computation, the single
 * guarded onChange, and per-tab rendering — so the "forgot confirmNav" and
 * "forgot the self-check" near-neighbor bugs that used to live in each layout's
 * copy-pasted Tabs block are now unrepresentable.
 *
 * Auth/loading gates stay in each layout (different hooks, different copy).
 */
interface SectionTabsProps {
  links: readonly NavLink[];
  /** Match sub-routes (/foo/123) to their parent tab via longest-prefix. Default: exact match. */
  prefixMatch?: boolean;
  /** Optional right-aligned content (e.g. a count badge) for a given tab href. */
  badgeFor?: (href: string) => React.ReactNode;
  /** Mantine bottom margin. Omit inside a <Stack> that already provides the gap. */
  mb?: string;
}

export function SectionTabs({ links, prefixMatch = false, badgeFor, mb }: SectionTabsProps) {
  const pathname = usePathname();
  const router = useRouter();
  const confirmNav = useConfirmNav();

  const active = prefixMatch
    ? [...links]
        .sort((a, b) => b.href.length - a.href.length)
        .find((l) => pathname === l.href || pathname.startsWith(`${l.href}/`))?.href ?? null
    : links.find((l) => pathname === l.href)?.href ?? null;

  return (
    <Tabs
      value={active}
      onChange={(value) => {
        if (value && value !== active && confirmNav()) router.push(value);
      }}
      mb={mb}
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
