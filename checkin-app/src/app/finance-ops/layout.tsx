"use client";

import { Box, Center, Loader, Stack, Text } from "@mantine/core";
import { SectionTabs } from "@/components/ui/SectionTabs";
import { PageContainer } from "@/components/ui/PageContainer";
import { REVENUE_OPS_SECTION_ROLES, revenueOpsTabs } from "@/lib/financeNav";
import { useRequireRole } from "@/hooks/useRequireRole";
import { useTodoCounts } from "@/hooks/useTodoCounts";
import { sectionTabBadge } from "@/components/navBadges";
import { TabBadge } from "@/components/ui/CountBadge";

/**
 * Revenue Ops chrome, shared by /finance-ops, /income and /donations. Admits
 * FINANCE or BOARD; a FINANCE-only viewer sees only the library tabs, and each
 * Board-only finance page enforces its own Board gate.
 */
export default function RevenueOpsLayout({ children }: { children: React.ReactNode }) {
  const { user, loading, ready } = useRequireRole(REVENUE_OPS_SECTION_ROLES);
  const counts = useTodoCounts(ready);

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

  const links = revenueOpsTabs(user, counts);
  return (
    <PageContainer>
      <SectionTabs
        links={links}
        prefixMatch
        mb="md"
        badgeFor={(href) => <TabBadge badge={sectionTabBadge(links, href, counts)} />}
      />
      <Box style={{ minWidth: 0 }}>{children}</Box>
    </PageContainer>
  );
}
