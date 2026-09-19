"use client";

import { useSession } from "next-auth/react";
import { Box, Center, Group, Loader, Stack, Text } from "@mantine/core";
import { MEMBERSHIP_OPS_SECTION_ROLES, isMembershipOpsAdmin, canReviewMembership, visibleMembershipOpsLinks } from "@/lib/membershipOpsNav";
import { useRequireRole } from "@/hooks/useRequireRole";
import { useTodoCounts } from "@/hooks/useTodoCounts";
import { tabBadgeFor, reviewBadges } from "@/components/navBadges";
import { CountBadge, badgeIntentFor } from "@/components/ui/CountBadge";
import { SectionTabs } from "@/components/ui/SectionTabs";
import { PageContainer } from "@/components/ui/PageContainer";

export default function MembershipOpsLayout({ children }: { children: React.ReactNode }) {
  const { data: session } = useSession();
  const sessionUser = session?.user as { isSysadmin?: boolean; isBoardMember?: boolean; isBackgroundCheckReviewer?: boolean; isOperations?: boolean } | undefined;
  const isAdmin = isMembershipOpsAdmin(sessionUser);
  const { loading, ready } = useRequireRole(MEMBERSHIP_OPS_SECTION_ROLES);

  // Fetch counts for reviewers too (not just admins), so the Review tab badges
  // work for a reviewer-only user.
  const canReview = canReviewMembership(sessionUser);
  const todoCounts = useTodoCounts(isAdmin || canReview);
  const navLinks = visibleMembershipOpsLinks(sessionUser);

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

  // Right-aligned count badge for a tab: pending applications, or the member-family total.
  const badgeFor = (href: string): React.ReactNode => {
    // Review tab shows two viewer-scoped badges: green (can act on now), gray
    // (approved, awaiting a second reviewer). Colors match the left-nav badges.
    if (href === "/membership-ops/review") {
      const badges = reviewBadges(todoCounts);
      if (badges.length === 0) return undefined;
      // Same mapping as the left-nav (AppFrame): green = action, gray = info,
      // both through the shared CountBadge so the tab count matches everywhere.
      return (
        <Group gap={4} wrap="nowrap">
          {badges.map((b) => (
            <CountBadge key={b.color} intent={b.color === "gray" ? "info" : "action"} aria-label={b.label}>
              {b.count}
            </CountBadge>
          ))}
        </Group>
      );
    }
    // Honor the badge's intent color (gray Applications total vs. red broken-email
    // count on Households) — same color→intent mapping the audit layout and left-nav use.
    const badge = tabBadgeFor(href, todoCounts);
    const intent = badge ? badgeIntentFor(badge.color) : null;
    if (badge && intent) {
      return (
        <CountBadge intent={intent} aria-label={badge.label}>
          {badge.count}
        </CountBadge>
      );
    }
    return undefined;
  };

  return (
    <PageContainer>
      <Stack>
        <SectionTabs links={navLinks} prefixMatch badgeFor={badgeFor} />
        <Box style={{ minWidth: 0 }}>{children}</Box>
      </Stack>
    </PageContainer>
  );
}
