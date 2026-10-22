"use client";

import { Box, Center, Loader, Stack, Text } from "@mantine/core";
import { SectionTabs } from "@/components/ui/SectionTabs";
import { PageContainer } from "@/components/ui/PageContainer";
import { visibleLinks } from "@/lib/nav/gates";
import { EXPENSE_OPS, EXPENSE_OPS_ROLES } from "@/lib/nav/sections/expenseOps";
import { useRequireRole } from "@/hooks/useRequireRole";
import { useTodoCounts } from "@/hooks/useTodoCounts";
import { sectionTabBadge } from "@/components/navBadges";
import { TabBadge } from "@/components/ui/CountBadge";

/** Expense Ops chrome for /expense. Admits FINANCE or BOARD. */
export default function ExpenseOpsLayout({ children }: { children: React.ReactNode }) {
  const { user, loading, ready } = useRequireRole(EXPENSE_OPS_ROLES);
  const counts = useTodoCounts(ready);

  if (loading) {
    return (
      <Center mih="60vh">
        <Stack align="center">
          <Loader />
          <Text>Verifying Expense Ops Access...</Text>
        </Stack>
      </Center>
    );
  }

  if (!ready) return null;

  const links = visibleLinks(EXPENSE_OPS, user, counts);
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
