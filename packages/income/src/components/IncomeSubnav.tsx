"use client";
import { Anchor, Group } from "@mantine/core";
import { usePathname } from "next/navigation";
import { INCOME_NAV_LINKS } from "../nav";

/** Links between the income screens; the host's section tabs show income as one tab. */
export default function IncomeSubnav() {
  const pathname = usePathname();
  return (
    <Group gap="md" mb="md">
      {INCOME_NAV_LINKS.map((l) => (
        <Anchor key={l.href} href={l.href} size="sm" fw={pathname?.startsWith(l.href) ? 700 : 400} underline={pathname?.startsWith(l.href) ? "always" : "hover"}>
          {l.icon} {l.name}
        </Anchor>
      ))}
    </Group>
  );
}
