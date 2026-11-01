"use client";

import { usePathname, useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useEffect } from "react";
import { Center, Loader, Stack, Text } from "@mantine/core";
import { PageContainer } from "@/components/ui/PageContainer";
import { settingsRolesFor } from "@/lib/nav/sections/settings";
import { hasAnyRole } from "@/lib/nav/gates";

// Settings is isSysadmin/board/operations, Finance is FINANCE/board, and the bare /settings
// index admits both so it can redirect each to their own tab. The gate lives here
// because the membership and finance settings pages self-gate nothing. Operations' only real
// destination is settings/outreach — every other settings page carries its own stricter
// useRequireRole(SETTINGS_ADMIN_ROLES) that bounces an operations session back out,
// the same layered pattern that keeps board members off the sysadmin-only localization tab.
export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const { data: session, status } = useSession();
  const router = useRouter();
  const allowed = hasAnyRole(session?.user, settingsRolesFor(usePathname() ?? ""));

  useEffect(() => {
    if (status === "unauthenticated") {
      router.push("/");
    } else if (status === "authenticated") {
      if (!allowed) router.push("/");
    }
  }, [status, allowed, router]);

  if (status === "loading") {
    return (
      <Center mih="60vh">
        <Stack align="center">
          <Loader />
          <Text>Verifying access...</Text>
        </Stack>
      </Center>
    );
  }

  if (!session || !allowed) {
    return null;
  }

  return <PageContainer>{children}</PageContainer>;
}
