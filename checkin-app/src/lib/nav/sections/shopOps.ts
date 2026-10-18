/** The Shop Ops tabs (shop-ops/layout.tsx); /shop-ops redirects to the role-appropriate tab. */
import type { NavSection, NavUser } from "@/lib/nav/types";
import { SYSADMIN_OR_BOARD, hasAnyRole } from "@/lib/nav/gates";

export interface ShopRoles {
  /** Sysadmin or Board Member: may create tools and see all assignments. */
  isAdmin: boolean;
  /** Admin, or explicitly holds MAY_CERTIFY_OTHERS: may grant certifications. */
  isCertifier: boolean;
}

export function shopRoles(user: NavUser | undefined): ShopRoles {
  const isAdmin = hasAnyRole(user, SYSADMIN_OR_BOARD);
  const isCertifier = isAdmin || !!user?.toolStatuses?.some((ts) => ts.level === "MAY_CERTIFY_OTHERS");
  return { isAdmin, isCertifier };
}

export const SHOP_OPS: NavSection = {
  id: "shop-ops",
  label: "Shop Ops",
  href: "/shop-ops",
  links: [
    { name: "Manage Tools & Certifications", href: "/shop-ops/manage", icon: "📋" },
    { name: "Create Tool", href: "/shop-ops/create", icon: "✨", visible: (u) => shopRoles(u).isAdmin },
    { name: "Live Certifications Center", href: "/shop-ops/live", icon: "📊" },
  ],
  visible: (u) => shopRoles(u).isCertifier,
};

/** Landing tab for /shop-ops: Manage for certifiers (incl. admins), else Live. */
export function defaultShopTab(roles: ShopRoles): string {
  return roles.isCertifier ? "/shop-ops/manage" : "/shop-ops/live";
}
