"use client";

import { usePathname, useRouter } from "next/navigation";
import { Box, Tabs } from "@mantine/core";
import { ScrollableTabsList } from "@/components/ui/ScrollableTabsList";
import { PageContainer } from "@/components/ui/PageContainer";
import { useIsDevInstance } from "@/components/EnvProvider";
import { DEV_TOOLS } from "@/lib/nav/sections/devTools";

/**
 * Persistent top tabs for the dev tools (captured-email inbox + Zoho Sign mock),
 * mirroring system-status/layout.tsx. No role gate — dev tools are for any signed-in
 * user on a dev instance (the cloud-dev box is already behind org login; local is
 * open). Off a dev instance the tabs are hidden and each child page 404s on its own.
 */
export default function DevToolsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const isDev = useIsDevInstance();

  if (!isDev) return <>{children}</>;

  const active = DEV_TOOLS.links.find((link) => pathname === link.href)?.href ?? null;

  return (
    <PageContainer>
      <Tabs value={active} onChange={(value) => value && value !== active && router.push(value)} mb="md">
        <ScrollableTabsList>
          {DEV_TOOLS.links.map((link) => (
            <Tabs.Tab key={link.href} value={link.href}>
              {link.name}
            </Tabs.Tab>
          ))}
        </ScrollableTabsList>
      </Tabs>
      <Box style={{ minWidth: 0 }}>{children}</Box>
    </PageContainer>
  );
}
