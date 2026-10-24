/** The Membership Audit tabs (membership-audit/layout.tsx). Sysadmin or board. */
import type { NavSection } from "@/lib/nav/types";
import { SYSADMIN_OR_BOARD, anyRole } from "@/lib/nav/gates";

export const MEMBERSHIP_AUDIT_ROLES = SYSADMIN_OR_BOARD;

export const MEMBERSHIP_AUDIT: NavSection = {
  id: "membership-audit",
  label: "Membership Audit",
  href: "/membership-audit",
  links: [
    { name: "Emergency Contacts", href: "/membership-audit/emergency-contacts", icon: "🚑" },
    { name: "Unclaimed Accounts", href: "/membership-audit/unclaimed", icon: "📨" },
    { name: "Broken Households", href: "/membership-audit/broken", icon: "⚠️" },
    { name: "Compliance", href: "/membership-audit/compliance", icon: "🚩" },
    { name: "BG Attestations", href: "/membership-audit/bg-attestations", icon: "✅" },
    { name: "Students 18+", href: "/membership-audit/turning-18", icon: "🎓" },
  ],
  visible: anyRole(MEMBERSHIP_AUDIT_ROLES),
};
