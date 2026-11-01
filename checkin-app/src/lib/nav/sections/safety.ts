/** The Safety tools (safety/layout.tsx). Trusted Adults is board-only. */
import type { RoleFlag } from "@/lib/roles";
import type { NavSection } from "@/lib/nav/types";
import { SYSADMIN_OR_BOARD, anyRole } from "@/lib/nav/gates";

export const SAFETY_ROLES: readonly RoleFlag[] = [...SYSADMIN_OR_BOARD, "isKeyholder"];
export const TRUSTED_ADULTS_ROLES = SYSADMIN_OR_BOARD;

export const SAFETY: NavSection = {
  id: "safety",
  label: "Safety",
  href: "/safety",
  links: [
    { name: "Emergency Contacts", href: "/safety/emergency-contacts", icon: "🚑" },
    { name: "Board Contact Info", href: "/safety/board-contacts", icon: "📞" },
    { name: "Pickup List", href: "/safety/pickup", icon: "📋" },
    { name: "Trusted Adults", href: "/safety/trusted-adults", icon: "🔗", visible: anyRole(TRUSTED_ADULTS_ROLES) },
  ],
  visible: anyRole(SAFETY_ROLES),
};
