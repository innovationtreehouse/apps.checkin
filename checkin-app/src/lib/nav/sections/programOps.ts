/**
 * The Program Ops tools (program-ops/layout.tsx); /program-ops redirects to the
 * first tab. Sysadmin or board; the layout also admits a program leader to the
 * edit screens of the programs they lead.
 */
import type { NavSection } from "@/lib/nav/types";
import { SYSADMIN_OR_BOARD, anyRole } from "@/lib/nav/gates";

export const PROGRAM_OPS: NavSection = {
  id: "program-ops",
  label: "Program Ops",
  href: "/program-ops",
  links: [
    { name: "All Programs", href: "/program-ops/programs", icon: "📚" },
    { name: "New Program", href: "/program-ops/new", icon: "✨" },
    { name: "One Time Events", href: "/program-ops/events", icon: "📋" },
    { name: "New One Time Event", href: "/program-ops/sessions", icon: "📅" },
  ],
  visible: anyRole(SYSADMIN_OR_BOARD),
};
