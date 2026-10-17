"use client";

import { usePathname, useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { Box, Center, Loader, Stack, Tabs, Text } from "@mantine/core";
import { useRequireRole } from "@/hooks/useRequireRole";
import { useTodoCounts } from "@/hooks/useTodoCounts";
import { tabBadgeFor } from "@/components/navBadges";
import { CountBadge, badgeIntentFor } from "@/components/ui/CountBadge";
import { ScrollableTabsList } from "@/components/ui/ScrollableTabsList";
import { PageContainer } from "@/components/ui/PageContainer";

const NAV_LINKS = [
  { name: "Emergency Contacts", href: "/membership-audit/emergency-contacts", icon: "🚑" },
  { name: "Unclaimed Accounts", href: "/membership-audit/unclaimed", icon: "📨" },
  { name: "Broken Households", href: "/membership-audit/broken", icon: "⚠️" },
  { name: "Compliance", href: "/membership-audit/compliance", icon: "🚩" },
  { name: "BG Attestations", href: "/membership-audit/bg-attestations", icon: "✅" },
  { name: "Students 18+", href: "/membership-audit/turning-18", icon: "🎓" },
];

export default function MembershipAuditLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { data: session } = useSession();
  const sessionUser = session?.user as { isSysadmin?: boolean; isBoardMember?: boolean } | undefined;
  const { loading, ready } = useRequireRole(["isSysadmin", "isBoardMember"]);
  const todoCounts = useTodoCounts(!!(sessionUser?.isSysadmin || sessionUser?.isBoardMember));

  if (loading) {
    return (
      <Center mih="60vh">
        <Stack align="center">
          <Loader />
          <Text>Verifying Membership Access...</Text>
        </Stack>
      </Center>
    );
  }

  if (!ready) return null;

  const activeTab =
    [...NAV_LINKS]
      .sort((a, b) => b.href.length - a.href.length)
      .find((l) => pathname === l.href || pathname.startsWith(l.href + "/"))?.href ?? null;

  // Emergency/Unclaimed are gray (gaps on the household), Broken is red (board must
  // assign a lead — blocking) — derived in navBadges.tabBadgeFor so nav and tab agree.
  return (
    <PageContainer>
      <Stack>
      <Tabs value={activeTab} onChange={(value) => value && router.push(value)}>
        <ScrollableTabsList>
          {NAV_LINKS.map((link) => {
            const badge = tabBadgeFor(link.href, todoCounts);
            const intent = badge ? badgeIntentFor(badge.color) : null;
            return (
              <Tabs.Tab
                key={link.href}
                value={link.href}
                leftSection={<span>{link.icon}</span>}
                rightSection={
                  badge && intent ? (
                    <CountBadge intent={intent} aria-label={badge.label}>
                      {badge.count}
                    </CountBadge>
                  ) : undefined
                }
              >
                {link.name}
              </Tabs.Tab>
            );
          })}
        </ScrollableTabsList>
      </Tabs>
      <Box style={{ minWidth: 0 }}>{children}</Box>
      </Stack>
    </PageContainer>
  );
}
