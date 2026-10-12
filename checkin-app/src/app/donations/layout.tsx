"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { Box, Center, Loader, Stack, Text } from "@mantine/core";
import { SectionTabs } from "@/components/ui/SectionTabs";
import { PageContainer } from "@/components/ui/PageContainer";
import { CountBadge } from "@/components/ui/CountBadge";
import { DONATION_NAV_LINKS, donationAreaLinks, isDonationViewerClient } from "@/lib/donationNav";

type NavCounts = { unassignedQueue: number; disbursementHolds: number };

export default function DonationsLayout({ children }: { children: React.ReactNode }) {
  const { data: session, status } = useSession();
  const router = useRouter();
  const authorized = isDonationViewerClient(session?.user);
  const [counts, setCounts] = useState<NavCounts | null>(null);

  useEffect(() => {
    if (status === "unauthenticated") router.push("/");
    else if (status === "authenticated" && !authorized) router.push("/");
  }, [status, authorized, router]);

  useEffect(() => {
    if (!authorized) return;
    fetch("/api/donations/nav-counts")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: NavCounts | null) => setCounts(data))
      // Badges are best-effort; a failed fetch just shows none.
      .catch(() => setCounts(null));
  }, [authorized]);

  if (status === "loading") {
    return (
      <Center mih="60vh">
        <Stack align="center">
          <Loader />
          <Text>Verifying Finance Access...</Text>
        </Stack>
      </Center>
    );
  }

  if (!authorized) return null;

  return (
    <PageContainer>
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
    </PageContainer>
  );
}
