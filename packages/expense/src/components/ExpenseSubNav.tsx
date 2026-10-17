"use client";
import { Button, Group } from "@mantine/core";
import { EXPENSE_SUB_NAV } from "../nav";

/** Navigation between the FINANCE/Board screens under the host's "Expenses" tab. */
export default function ExpenseSubNav({ current }: { current: string }) {
  return (
    <Group gap="xs" mb="md">
      {EXPENSE_SUB_NAV.map((l) => (
        <Button key={l.href} component="a" href={l.href} size="xs" variant={l.href === current ? "filled" : "subtle"}>
          {l.icon} {l.name}
        </Button>
      ))}
    </Group>
  );
}
