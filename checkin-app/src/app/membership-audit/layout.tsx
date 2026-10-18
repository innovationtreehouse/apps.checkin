"use client";

import { usePathname, useRouter } from "next/navigation";
import { Box, Center, Loader, Stack, Tabs, Text } from "@mantine/core";
import { useRequireRole } from "@/hooks/useRequireRole";
import { useTodoCounts } from "@/hooks/useTodoCounts";
import { tabBadgeFor } from "@/components/navBadges";
import { CountBadge, badgeIntentFor } from "@/components/ui/CountBadge";
import { ScrollableTabsList } from "@/components/ui/ScrollableTabsList";
import { PageContainer } from "@/components/ui/PageContainer";
import { MEMBERSHIP_AUDIT, MEMBERSHIP_AUDIT_ROLES } from "@/lib/nav/sections/membershipAudit";

export default function MembershipAuditLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { loading, ready } = useRequireRole(MEMBERSHIP_AUDIT_ROLES);
  const todoCounts = useTodoCounts(ready);

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
    [...MEMBERSHIP_AUDIT.links]
      .sort((a, b) => b.href.length - a.href.length)
      .find((l) => pathname === l.href || pathname.startsWith(l.href + "/"))?.href ?? null;

  // Emergency/Unclaimed are gray (gaps on the household), Broken is red (board must
  // assign a lead — blocking) — derived in navBadges.tabBadgeFor so nav and tab agree.
  return (
    <PageContainer>
      <Stack>
      <Tabs value={activeTab} onChange={(value) => value && router.push(value)}>
        <ScrollableTabsList>
          {MEMBERSHIP_AUDIT.links.map((link) => {
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
