"use client";

import { usePathname } from "next/navigation";
import { Box, Center, Loader, Stack, Text } from "@mantine/core";
import { SectionTabs, activeTab } from "@/components/ui/SectionTabs";
import { TabBadge } from "@/components/ui/CountBadge";
import { PageContainer } from "@/components/ui/PageContainer";
import { sectionTabBadge } from "@/components/navBadges";
import { visibleLinks } from "@/lib/nav/gates";
import { DONATIONS, donationsRolesFor } from "@/lib/nav/sections/donations";
import { useRequireRole } from "@/hooks/useRequireRole";
import { useTodoCounts } from "@/hooks/useTodoCounts";

/**
 * Donations chrome and gate: the Benevity and In-Kind tabs, and the open tab's
 * screens as a pill row. The donation screens admit FINANCE or BOARD; the
 * no-receipt in-kind gift screen also admits OPERATIONS and INVENTORY_MANAGER.
 */
export default function DonationsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "";
  const { user, loading, ready } = useRequireRole(donationsRolesFor(pathname));
  const counts = useTodoCounts(ready);

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

  const links = visibleLinks(DONATIONS, user, counts);
  const subLinks = activeTab(links, pathname, true)?.subLinks;
  return (
    <PageContainer>
      <SectionTabs
        links={links}
        prefixMatch
        mb={subLinks ? "xs" : "md"}
        badgeFor={(href) => <TabBadge badge={sectionTabBadge(links, href, counts)} />}
      />
      {subLinks && (
        <SectionTabs
          links={subLinks}
          prefixMatch
          mb="md"
          variant="pills"
          badgeFor={(href) => <TabBadge badge={sectionTabBadge(subLinks, href, counts)} />}
        />
      )}
      <Box style={{ minWidth: 0 }}>{children}</Box>
    </PageContainer>
  );
}
