"use client";

import { Box } from "@mantine/core";
import { usePathname } from "next/navigation";
import { SectionTabs } from "@/components/ui/SectionTabs";
import { PageContainer } from "@/components/ui/PageContainer";
import { visibleLinks } from "@/lib/nav/gates";
import type { RoleFlag } from "@/lib/roles";
import {
  QBO_CODES_PATH,
  QBO_CODES_ROLES,
  SYSTEM_STATUS,
  SYSTEM_STATUS_ROLES,
  UNSYNCED_REVIEW_ROLES,
} from "@/lib/nav/sections/systemStatus";
import { useRequireRole } from "@/hooks/useRequireRole";

import { PageLoader } from "@/components/ui/PageLoader";

function isUnsyncedPath(pathname: string | null) {
  return (
    pathname === "/system-status/unsynced-scans" ||
    (pathname?.startsWith("/system-status/unsynced-scans/") ?? false)
  );
}

/** Keyholders are admitted on Unsynced Scans and finance on QuickBooks codes; every other tab is sysadmin or board. */
function rolesFor(pathname: string | null): readonly RoleFlag[] {
  if (isUnsyncedPath(pathname)) return UNSYNCED_REVIEW_ROLES;
  if (pathname === QBO_CODES_PATH) return QBO_CODES_ROLES;
  return SYSTEM_STATUS_ROLES;
}

export default function SystemStatusLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { loading, ready, user } = useRequireRole(rolesFor(pathname));

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
