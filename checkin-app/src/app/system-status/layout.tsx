"use client";

import { Box } from "@mantine/core";
import { usePathname } from "next/navigation";
import { SectionTabs } from "@/components/ui/SectionTabs";
import { PageContainer } from "@/components/ui/PageContainer";
import { visibleLinks } from "@/lib/nav/gates";
import { SYSTEM_STATUS, SYSTEM_STATUS_ROLES, UNSYNCED_REVIEW_ROLES } from "@/lib/nav/sections/systemStatus";
import { useRequireRole } from "@/hooks/useRequireRole";

import { PageLoader } from "@/components/ui/PageLoader";

function isUnsyncedPath(pathname: string | null) {
  return (
    pathname === "/system-status/unsynced-scans" ||
    (pathname?.startsWith("/system-status/unsynced-scans/") ?? false)
  );
}

export default function SystemStatusLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const unsynced = isUnsyncedPath(pathname);
  const { loading, ready, user } = useRequireRole(unsynced ? UNSYNCED_REVIEW_ROLES : SYSTEM_STATUS_ROLES);

  if (loading) {
    return (
      <PageLoader />
    );
  }

  if (!ready) return null;

  const links = visibleLinks(SYSTEM_STATUS, user, null);

  return (
    <PageContainer>
      <SectionTabs links={links} mb="md" />
      <Box style={{ minWidth: 0 }}>{children}</Box>
    </PageContainer>
  );
}
