"use client";
import { Badge, Tooltip } from "@mantine/core";

/** Marks a line receiving called non-inventory: finance picks its bucket and QuickBooks account by hand. */
export default function NonInventoryBadge() {
  return (
    <Tooltip label="Not a catalog part: Finance picks its bucket and QuickBooks account on every expense">
      <Badge ml="xs" size="xs" variant="light" color="gray">Non-inventory</Badge>
    </Tooltip>
  );
}
