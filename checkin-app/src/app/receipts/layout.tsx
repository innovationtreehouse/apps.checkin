"use client";

import { useEffect } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { Box, Center, Loader, Stack, Text } from "@mantine/core";
import { SectionTabs } from "@/components/ui/SectionTabs";
import { PageContainer } from "@/components/ui/PageContainer";
import { linkAllowed } from "@/lib/nav/gates";
import type { NavSection, NavUser } from "@/lib/nav/types";
import { MY_RECEIPTS } from "@/lib/nav/sections/myReceipts";
import { FINANCE } from "@/lib/nav/sections/finance";
import { useTodoCounts } from "@/hooks/useTodoCounts";
import { sectionTabBadge } from "@/components/navBadges";
import { TabBadge } from "@/components/ui/CountBadge";

const allowedLinks = (section: NavSection, user: NavUser | undefined) =>
  section.links.filter((l) => linkAllowed(section, l, user, null));

/**
 * /receipts hosts My Receipts (the list, upload and a receipt's detail at
 * /receipts/[id]) and two Finance pages (receipt settings and the held-mail
 * queue). The tab strip is the section the page belongs to; /receipts/[id]
 * shows Finance to a reviewer who cannot submit, or when opened from the queue.
 */
export default function ReceiptsLayout({ children }: { children: React.ReactNode }) {
  const { data: session, status } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const fromQueue = useSearchParams().get("queue") !== null;
  const user = session?.user;
  const counts = useTodoCounts(status === "authenticated");
  const mine = allowedLinks(MY_RECEIPTS, user);
  const review = allowedLinks(FINANCE, user);
  const authorized = mine.length > 0 || review.length > 0;
  const onReviewPage = fromQueue || FINANCE.links.flatMap((l) => [l, ...(l.subLinks ?? [])]).some((l) => pathname === l.href || pathname.startsWith(`${l.href}/`));
  const links = (onReviewPage && review.length > 0) || mine.length === 0 ? review : mine;

  useEffect(() => {
    if (status === "unauthenticated" || (status === "authenticated" && !authorized)) router.push("/");
  }, [status, authorized, router]);

  if (status === "loading") {
    return (
      <Center mih="60vh">
        <Stack align="center">
          <Loader />
          <Text>Verifying Receipt Access...</Text>
        </Stack>
      </Center>
    );
  }

  if (!authorized) return null;

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
