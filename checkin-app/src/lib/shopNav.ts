import type { NavLink } from "@/lib/nav/types";

/** The role fields shopRoles reads — satisfied by the NextAuth session user and
 *  by the /index directory's RegistryUser alike, so both resolve the same gate. */
type ShopRoleUser = {
  isSysadmin?: boolean;
  isBoardMember?: boolean;
  toolStatuses?: Array<{ level: string }>;
};

/**
 * Single source of truth for the Shop Ops tabs. Rendered as the persistent top
 * tabs (shop/layout.tsx); /shop itself redirects to the role-appropriate tab.
 *
 * Tabs are role-gated, so unlike facilityNav each link carries a `visible`
 * predicate over the viewer's resolved roles.
 */
export interface ShopRoles {
  /** Sysadmin or Board Member — may create tools and see all assignments. */
  isAdmin: boolean;
  /** Admin, or explicitly holds MAY_CERTIFY_OTHERS — may grant certifications. */
  isCertifier: boolean;
}

export interface ShopNavLink extends NavLink {
  visible: (roles: ShopRoles) => boolean;
}

export const SHOP_NAV_LINKS: ShopNavLink[] = [
  { name: "Manage Tools & Certifications", href: "/shop-ops/manage", icon: "📋", visible: (r) => r.isCertifier },
  { name: "Create Tool", href: "/shop-ops/create", icon: "✨", visible: (r) => r.isAdmin },
  { name: "Live Certifications Center", href: "/shop-ops/live", icon: "📊", visible: () => true },
];

export function shopRoles(user: ShopRoleUser | undefined): ShopRoles {
  const isAdmin = !!user?.isSysadmin || !!user?.isBoardMember;
  const isCertifier =
    isAdmin || !!user?.toolStatuses?.some((ts) => ts.level === "MAY_CERTIFY_OTHERS");
  return { isAdmin, isCertifier };
}

/** Landing tab for /shop: Manage for certifiers (incl. admins), else Live. */
export function defaultShopTab(roles: ShopRoles): string {
  return roles.isCertifier ? "/shop-ops/manage" : "/shop-ops/live";
}
