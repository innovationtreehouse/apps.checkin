"use client";

import { usePathname, useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { Box, Center, Loader, Stack, Tabs, Text } from "@mantine/core";
import { useRequireRole } from "@/hooks/useRequireRole";
import { SAFETY_SECTION_ROLES } from "@/lib/safetyNav";
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
  const sessionUser = session?.user as { isSysadmin?: boolean; isBoardMember?: boolean } | undefined;
  const isBoard = !!(sessionUser?.isSysadmin || sessionUser?.isBoardMember);
  const { loading, ready } = useRequireRole(SAFETY_SECTION_ROLES);
  // Trusted-adult disclosures awaiting board review — same count as the Safety nav badge
  // (derived in navBadges.tabBadgeFor so nav and tab can't diverge).
  const counts = useTodoCounts(isBoard);
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

  // Trusted Adults is board-only. /safety redirects to the first tab.
  const tabs: { name: string; href: string; count?: number }[] = [
    { name: "🚑 Emergency Contacts", href: "/safety/emergency-contacts" },
    { name: "📞 Board Contact Info", href: "/safety/board-contacts" },
    { name: "📋 Pickup List", href: "/safety/pickup" },
    ...(isBoard ? [{ name: "🔗 Trusted Adults", href: "/safety/trusted-adults", count: taCount }] : []),
  ];
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
