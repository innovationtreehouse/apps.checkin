import { IconChevronDown, IconChevronUp, IconSelector } from "@tabler/icons-react";

/** A list header that stays put while its rows scroll. */
export const THEAD_STYLE = { position: "sticky" as const, top: 0, background: "var(--mantine-color-body)", zIndex: 1 };

export function SortIcon({ active, dir }: { active: boolean; dir: "asc" | "desc" }) {
  if (!active) return <IconSelector size={14} />;
  return dir === "asc" ? <IconChevronUp size={14} /> : <IconChevronDown size={14} />;
}
