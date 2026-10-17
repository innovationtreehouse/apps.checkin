"use client";

import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useEffect } from "react";
import { Center, Loader, Stack, Text } from "@mantine/core";
import { PageContainer } from "@/components/ui/PageContainer";
import type { BusinessRole } from "@/types/auth";
import { SETTINGS_SECTION_ROLES } from "@/lib/settingsNav";

type SettingsUser = Partial<Record<BusinessRole, boolean>>;

const admitsSettings = (u: SettingsUser | undefined): boolean =>
  SETTINGS_SECTION_ROLES.some((r) => u?.[r] === true);

// Settings is isSysadmin/board/operations. Gate here since these pages were moved out of
// /admin: the membership settings page self-gates nothing and relied on the admin layout.
// Operations only actually has a real destination today (settings/outreach) — every other
// settings page carries its own stricter useRequireRole(['isSysadmin','isBoardMember']) that
// bounces an operations session straight back out, the same layered pattern that already
// keeps board members off the sysadmin-only localization tab.
export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const { data: session, status } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (status === "unauthenticated") {
      router.push("/");
    } else if (status === "authenticated") {
      const user = session?.user as SettingsUser;
      if (!admitsSettings(user)) router.push("/");
    }
  }, [status, session, router]);

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

  const user = session?.user as SettingsUser;
  if (!session || !admitsSettings(user)) {
    return null;
  }

  return <PageContainer>{children}</PageContainer>;
}
