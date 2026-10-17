"use client";

import { Box } from "@mantine/core";
import { usePathname } from "next/navigation";
import { SectionTabs } from "@/components/ui/SectionTabs";
import { PageContainer } from "@/components/ui/PageContainer";
import { SYSTEM_STATUS_NAV_LINKS } from "@/lib/systemStatusNav";
import { useRequireRole } from "@/hooks/useRequireRole";
import type { BusinessRole } from "@/types/auth";

import { PageLoader } from "@/components/ui/PageLoader";

// Q15: keyholders review parked scans. #1633: operations do not — aggregate
// attendance only. Other System Status tabs stay board/sysadmin.
const ADMIN: BusinessRole[] = ["isSysadmin", "isBoardMember"];
const REVIEWERS: BusinessRole[] = ["isSysadmin", "isBoardMember", "isKeyholder"];

function isUnsyncedPath(pathname: string | null) {
  return (
    pathname === "/system-status/unsynced-scans" ||
    (pathname?.startsWith("/system-status/unsynced-scans/") ?? false)
  );
}

export default function SystemStatusLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const unsynced = isUnsyncedPath(pathname);
  const { loading, ready, user } = useRequireRole(unsynced ? REVIEWERS : ADMIN);

  if (loading) {
    return (
      <PageLoader />
    );
  }

  if (!ready) return null;

  const admin = user?.isSysadmin === true || user?.isBoardMember === true;
  const links = admin
    ? SYSTEM_STATUS_NAV_LINKS
    : SYSTEM_STATUS_NAV_LINKS.filter((l) => l.href === "/system-status/unsynced-scans");

  return (
    <PageContainer>
      <SectionTabs links={links} mb="md" />
      <Box style={{ minWidth: 0 }}>{children}</Box>
    </PageContainer>
  );
}
