"use client";

import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { Tabs } from "@mantine/core";
import { ScrollableTabsList } from "@/components/ui/ScrollableTabsList";
import { useConfirmNav } from "@/components/UnsavedChangesProvider";
import { useTodoCounts } from "@/hooks/useTodoCounts";
import { settingsMisconfigBadge } from "@/components/navBadges";
import { CountBadge } from "@/components/ui/CountBadge";

export type SettingsTab = "membership" | "localization" | "email" | "shopify-webhook" | "outreach";

// sysadminOnly tabs are hidden from board members (the /settings layout admits both).
const TABS: { value: SettingsTab; label: string; href: string; sysadminOnly?: boolean }[] = [
  { value: "membership", label: "Membership Settings", href: "/settings/membership" },
  { value: "email", label: "Email", href: "/settings/email" },
  { value: "outreach", label: "Outreach", href: "/settings/outreach" },
  { value: "shopify-webhook", label: "Shopify Webhook", href: "/settings/shopify-webhook" },
  { value: "localization", label: "Localization", href: "/settings/localization", sysadminOnly: true },
];

/**
 * Shared tab bar across the Settings-area pages, so Membership Settings and
 * Role Assignment read as one section. Navigates on change (each tab is its own
 * route).
 */
export function SettingsTabs({ active }: { active: SettingsTab }) {
  const router = useRouter();
  const confirmNav = useConfirmNav();
  const { data: session } = useSession();
  const isSysadmin = !!session?.user?.isSysadmin;
  const tabs = TABS.filter((t) => !t.sysadminOnly || isSysadmin);
  // Red pill on Membership Settings when a required membership setting is unset. Same
  // shared counts as the nav badge, so tab and nav can't diverge.
  const misconfig = settingsMisconfigBadge(useTodoCounts(!!session));
  return (
    <Tabs
      value={active}
      onChange={(value) => {
        const tab = tabs.find((t) => t.value === value);
        if (tab && value !== active) {
          if (!confirmNav()) return;
          router.push(tab.href);
        }
      }}
      mb="md"
    >
      <ScrollableTabsList>
        {tabs.map((t) => (
          <Tabs.Tab
            key={t.value}
            value={t.value}
            rightSection={
              t.value === "membership" && misconfig ? (
                <CountBadge intent="alert" size="sm" aria-label={misconfig.label}>
                  {misconfig.count}
                </CountBadge>
              ) : undefined
            }
          >
            {t.label}
          </Tabs.Tab>
        ))}
      </ScrollableTabsList>
    </Tabs>
  );
}
