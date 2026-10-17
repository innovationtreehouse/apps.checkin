"use client";

import { usePathname, useRouter } from "next/navigation";
import { Tabs } from "@mantine/core";

// Route-based tabs (URLs stay separate, like FacilityLayout). Rendered inside
// each page rather than a layout.tsx so the Current page can suppress it in
// kiosk mode and the certifications subroute isn't wrapped.
const TABS = [
  { href: "/attendance/current", label: "Current" },
  { href: "/attendance/manual", label: "Add Past Visit" },
  { href: "/attendance/my-visits", label: "My Visits" },
  { href: "/attendance/household", label: "Household Check-ins" },
];

export function AttendanceTabs() {
  const pathname = usePathname();
  const router = useRouter();
  const active = TABS.find((t) => t.href === pathname)?.href ?? null;

  return (
    <Tabs
      value={active}
      onChange={(value) => { if (value && value !== active) router.push(value); }}
      mb="md"
    >
      <Tabs.List>
        {TABS.map((t) => (
          <Tabs.Tab key={t.href} value={t.href}>{t.label}</Tabs.Tab>
        ))}
      </Tabs.List>
    </Tabs>
  );
}
