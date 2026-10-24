"use client";

import { useSession } from "next-auth/react";
import { Box } from "@mantine/core";
import { SectionTabs } from "@/components/ui/SectionTabs";
import { PageContainer } from "@/components/ui/PageContainer";
import { visibleLinks } from "@/lib/nav/gates";
import { INVENTORY } from "@/lib/nav/sections/inventory";
import { RECEIPT_FLOW_LINK, RECEIPT_REVIEW } from "@/lib/nav/sections/receiptReview";
import { useTodoCounts } from "@/hooks/useTodoCounts";
import { sectionTabBadge } from "@/components/navBadges";
import { TabBadge } from "@/components/ui/CountBadge";

/**
 * The flow status page sits under Receipt Review's tabs for FINANCE or BOARD, and under
 * Inventory's for an inventory manager. The page keeps its own gate.
 */
export default function ReceiptFlowLayout({ children }: { children: React.ReactNode }) {
  const { data: session, status } = useSession();
  const counts = useTodoCounts(status === "authenticated");
  const review = visibleLinks(RECEIPT_REVIEW, session?.user, counts);
  const links = review.some((l) => l.href === RECEIPT_FLOW_LINK.href) ? review : visibleLinks(INVENTORY, session?.user, counts);

  return (
    <PageContainer>
      {links.length > 0 && (
        <SectionTabs links={links} mb="md" badgeFor={(href) => <TabBadge badge={sectionTabBadge(links, href, counts)} />} />
      )}
      <Box style={{ minWidth: 0 }}>{children}</Box>
    </PageContainer>
  );
}
