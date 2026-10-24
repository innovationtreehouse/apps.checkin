"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { Box, Center, Loader, Stack, Text } from "@mantine/core";
import { SectionTabs, activeTab } from "@/components/ui/SectionTabs";
import { PageContainer } from "@/components/ui/PageContainer";
import { visibleLinks } from "@/lib/nav/gates";
import { INVENTORY } from "@/lib/nav/sections/inventory";
import { canSeeCatalog } from "@/lib/volunteer";
import { useTodoCounts } from "@/hooks/useTodoCounts";
import { sectionTabBadge } from "@/components/navBadges";
import { TabBadge } from "@/components/ui/CountBadge";

export default function CatalogLayout({ children }: { children: React.ReactNode }) {
  const { data: session, status } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const counts = useTodoCounts(status === "authenticated");
  const links = visibleLinks(INVENTORY, session?.user, counts);
  // Admitted as a catalog viewer, or as a library tab's own audience (e.g.
  // FINANCE on Receiving). Tab visibility needs the release list from counts, so
  // the redirect waits for counts. Each page and route keeps its own gate.
  const authorized = canSeeCatalog(session?.user) || links.length > 0;

  useEffect(() => {
    if (status === "unauthenticated") router.push("/");
    else if (status === "authenticated" && counts !== null && !authorized) router.push("/");
  }, [status, counts, authorized, router]);

  if (status === "loading" || (!authorized && counts === null)) {
    return (
      <Center mih="60vh">
        <Stack align="center">
          <Loader />
          <Text>Verifying Inventory Access...</Text>
        </Stack>
      </Center>
    );
  }

  if (!authorized) return null;

  const subLinks = activeTab(links, pathname)?.subLinks;
  return (
    <PageContainer>
      <SectionTabs
        links={links}
        mb={subLinks ? "xs" : "md"}
        badgeFor={(href) => <TabBadge badge={sectionTabBadge(links, href, counts)} />}
      />
      {subLinks && (
        <SectionTabs
          links={subLinks}
          mb="md"
          variant="pills"
          badgeFor={(href) => <TabBadge badge={sectionTabBadge(subLinks, href, counts)} />}
        />
      )}
      <Box style={{ minWidth: 0 }}>{children}</Box>
    </PageContainer>
  );
}
