"use client";

import { Box, Center, Loader, Stack, Text } from "@mantine/core";
import { usePathname } from "next/navigation";
import { SectionTabs, activeTab } from "@/components/ui/SectionTabs";
import { PageContainer } from "@/components/ui/PageContainer";
import { visibleLinks } from "@/lib/nav/gates";
import { REVENUE_OPS, REVENUE_OPS_ROLES } from "@/lib/nav/sections/revenueOps";
import { useRequireRole } from "@/hooks/useRequireRole";
import { useTodoCounts } from "@/hooks/useTodoCounts";
import { sectionTabBadge } from "@/components/navBadges";
import { TabBadge } from "@/components/ui/CountBadge";

/**
 * Revenue Ops chrome, shared by /finance-ops, /income and /donations. Admits
 * FINANCE or BOARD; a FINANCE-only viewer sees only the library tabs, and each
 * Board-only finance page enforces its own Board gate. A tab with sub-links
 * (Shopify) shows them as a second row while one of its pages is open.
 */
export default function RevenueOpsLayout({ children }: { children: React.ReactNode }) {
  const { user, loading, ready } = useRequireRole(REVENUE_OPS_ROLES);
  const counts = useTodoCounts(ready);
  const pathname = usePathname();

  if (loading) {
    return (
      <Center mih="60vh">
        <Stack align="center">
          <Loader />
          <Text>Verifying Revenue Ops Access...</Text>
        </Stack>
      </Center>
    );
  }

  if (!ready) return null;

  const links = visibleLinks(REVENUE_OPS, user, counts);
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
