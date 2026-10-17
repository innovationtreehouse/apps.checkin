"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { Box } from "@mantine/core";
import { SectionTabs } from "@/components/ui/SectionTabs";
import { CountBadge } from "@/components/ui/CountBadge";
import { DONATION_NAV_LINKS, donationAreaLinks, isDonationViewerClient } from "@/lib/donationNav";
import RevenueOpsLayout from "../finance-ops/layout";

type NavCounts = { unassignedQueue: number; disbursementHolds: number };

/** Revenue Ops chrome and gate, with the donation screens as a second tab row. */
export default function DonationsLayout({ children }: { children: React.ReactNode }) {
  const { data: session } = useSession();
  const authorized = isDonationViewerClient(session?.user);
  const [counts, setCounts] = useState<NavCounts | null>(null);

  useEffect(() => {
    if (!authorized) return;
    fetch("/api/donations/nav-counts")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: NavCounts | null) => setCounts(data))
      // Badges are best-effort; a failed fetch just shows none.
      .catch(() => setCounts(null));
  }, [authorized]);

  return (
    <RevenueOpsLayout>
      <SectionTabs
        links={donationAreaLinks}
        mb="md"
        badgeFor={(href) => {
          const field = DONATION_NAV_LINKS.find((l) => l.href === href)?.badge;
          const n = field && counts ? counts[field] : 0;
          return n > 0 ? <CountBadge intent="action">{n}</CountBadge> : null;
        }}
      />
      <Box style={{ minWidth: 0 }}>{children}</Box>
    </RevenueOpsLayout>
  );
}
