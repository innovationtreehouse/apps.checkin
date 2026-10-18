"use client";

import { usePathname, useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { Box, Center, Loader, Stack, Tabs, Text } from "@mantine/core";
import { useRequireRole } from "@/hooks/useRequireRole";
import { linkGate, visibleLinks } from "@/lib/nav/gates";
import { SAFETY, SAFETY_ROLES } from "@/lib/nav/sections/safety";
import { useTodoCounts } from "@/hooks/useTodoCounts";
import { tabBadgeFor } from "@/components/navBadges";
import { CountBadge } from "@/components/ui/CountBadge";
import { ScrollableTabsList } from "@/components/ui/ScrollableTabsList";
import { PageContainer } from "@/components/ui/PageContainer";
import { useConfirmNav } from "@/components/UnsavedChangesProvider";

export default function SafetyLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const confirmNav = useConfirmNav();
  const { data: session } = useSession();
  const sessionUser = session?.user;
  const seesTrustedAdults = linkGate(SAFETY, "/safety/trusted-adults")(sessionUser, null);
  const { loading, ready } = useRequireRole(SAFETY_ROLES);
  // Trusted-adult disclosures awaiting board review — same count as the Safety nav badge
  // (derived in navBadges.tabBadgeFor so nav and tab can't diverge).
  const counts = useTodoCounts(seesTrustedAdults);
  const taCount = tabBadgeFor("/safety/trusted-adults", counts)?.count ?? 0;

  if (loading) {
    return (
      <Center mih="60vh">
        <Stack align="center">
          <Loader />
          <Text>Verifying Safety Access...</Text>
        </Stack>
      </Center>
    );
  }

  if (!ready) return null;

  // /safety redirects to the first tab.
  const tabs = visibleLinks(SAFETY, sessionUser, null).map((l) => ({
    name: `${l.icon} ${l.name}`,
    href: l.href,
    count: l.href === "/safety/trusted-adults" ? taCount : undefined,
  }));
  const active = tabs.find((t) => pathname === t.href)?.href ?? null;

  return (
    <PageContainer>
      <Tabs
        value={active}
        onChange={(value) => {
          if (value && value !== active && confirmNav()) router.push(value);
        }}
        mb="md"
      >
        <ScrollableTabsList>
          {tabs.map((t) => (
            <Tabs.Tab
              key={t.href}
              value={t.href}
              // Active tab recolors its content to the tabs color (green); pin dark text so the
              // green count badge isn't rendered green-on-green on the active tab.
              rightSection={t.count ? <CountBadge intent="action">{t.count}</CountBadge> : undefined}
            >
              {t.name}
            </Tabs.Tab>
          ))}
        </ScrollableTabsList>
      </Tabs>
      <Box style={{ minWidth: 0 }}>{children}</Box>
    </PageContainer>
  );
}
