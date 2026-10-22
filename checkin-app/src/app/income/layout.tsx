"use client";

import { Box } from "@mantine/core";
import { SectionTabs } from "@/components/ui/SectionTabs";
import { TabBadge } from "@/components/ui/CountBadge";
import { INCOME_NAV_LINKS } from "@checkin/income/nav";
import { incomeBadge } from "@/lib/nav/sections/revenueOps";
import { useTodoCounts } from "@/hooks/useTodoCounts";
import RevenueOpsLayout from "../finance-ops/layout";

const incomeLinks = INCOME_NAV_LINKS.map(({ name, href, icon }) => ({ name, href, icon }));

/** The income screens as a second tab row, badged from the same counts as the Income tab. */
function IncomeTabs() {
  const counts = useTodoCounts(true);
  return (
    <SectionTabs
      links={incomeLinks}
      prefixMatch
      mb="md"
      badgeFor={(href) => {
        const key = INCOME_NAV_LINKS.find((l) => l.href === href)?.badge;
        return <TabBadge badge={key ? incomeBadge(counts, [key]) : null} />;
      }}
    />
  );
}

/** Revenue Ops chrome and gate, with the income screens as a second tab row. */
export default function IncomeLayout({ children }: { children: React.ReactNode }) {
  return (
    <RevenueOpsLayout>
      <IncomeTabs />
      <Box style={{ minWidth: 0 }}>{children}</Box>
    </RevenueOpsLayout>
  );
}
