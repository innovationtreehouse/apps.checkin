"use client";

import { usePathname } from "next/navigation";
import { Box, Center, Loader, Stack, Text } from "@mantine/core";
import { SectionTabs } from "@/components/ui/SectionTabs";
import { CountBadge } from "@/components/ui/CountBadge";
import { PageContainer } from "@/components/ui/PageContainer";
import { DONATION_NAV_LINKS } from "@checkin/bulk-donation/nav";
import { hasAnyRole, visibleLinks } from "@/lib/nav/gates";
import { DONATIONS, DONATION_SCREEN_ROLES, donationsRolesFor } from "@/lib/nav/sections/donations";
import { useRequireRole } from "@/hooks/useRequireRole";
import { useTodoCounts } from "@/hooks/useTodoCounts";
import { useLoad } from "@/lib/api";

type NavCounts = { unassignedQueue: number; disbursementHolds: number };

/**
 * Donations chrome and gate. The donation screens admit FINANCE or BOARD; the
 * in-kind gift screen also admits OPERATIONS and INVENTORY_MANAGER.
 */
export default function DonationsLayout({ children }: { children: React.ReactNode }) {
  const { user, loading, ready } = useRequireRole(donationsRolesFor(usePathname() ?? ""));
  const todoCounts = useTodoCounts(ready);
  const countsAllowed = ready && hasAnyRole(user, DONATION_SCREEN_ROLES);
  // Badges are best-effort, so a failed load shows none.
  const { data: counts } = useLoad<NavCounts>(countsAllowed ? "/api/donations/nav-counts" : null);

  if (loading) {
    return (
      <Center mih="60vh">
        <Stack align="center">
          <Loader />
          <Text>Verifying Donations Access...</Text>
        </Stack>
      </Center>
    );
  }

  if (!ready) return null;

  const links = visibleLinks(DONATIONS, user, todoCounts);
  return (
    <PageContainer>
      <SectionTabs
        links={links}
        prefixMatch
        mb="md"
        badgeFor={(href) => {
          const field = DONATION_NAV_LINKS.find((l) => l.href === href)?.badge;
          const n = field && counts ? counts[field] : 0;
          return n > 0 ? <CountBadge intent="action">{n}</CountBadge> : null;
        }}
      />
      <Box style={{ minWidth: 0 }}>{children}</Box>
    </PageContainer>
  );
}
