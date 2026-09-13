"use client";

import { Box, Center, Loader, Stack, Text } from "@mantine/core";
import { SectionTabs } from "@/components/ui/SectionTabs";
import { PageContainer } from "@/components/ui/PageContainer";
import { FINANCE_NAV_LINKS, FINANCE_SECTION_ROLES } from "@/lib/financeNav";
import { useRequireRole } from "@/hooks/useRequireRole";
import { useTodoCounts } from "@/hooks/useTodoCounts";
import { tabBadgeFor } from "@/components/navBadges";
import { CountBadge } from "@/components/ui/CountBadge";

export default function FinanceOpsLayout({ children }: { children: React.ReactNode }) {
  const { loading, ready } = useRequireRole(FINANCE_SECTION_ROLES);
  const counts = useTodoCounts(true);

  if (loading) {
    return (
      <Center mih="60vh">
        <Stack align="center">
          <Loader />
          <Text>Verifying Finance Access...</Text>
        </Stack>
      </Center>
    );
  }

  if (!ready) return null;

  return (
    <PageContainer>
      <SectionTabs
        links={FINANCE_NAV_LINKS}
        mb="md"
        badgeFor={(href) => {
          const b = tabBadgeFor(href, counts);
          return b ? <CountBadge intent="action">{b.count}</CountBadge> : null;
        }}
      />
      <Box style={{ minWidth: 0 }}>{children}</Box>
    </PageContainer>
  );
}
