/**
 * Nav descriptors for org inventory (#1287 §7). The library declares its
 * screens; the host places them in its Inventory section tabs, orders them,
 * and hides the manager-only ones from viewers.
 */

export interface InventoryNavLink {
  name: string;
  href: string;
  /** Emoji icon (the host's SectionTabs render an emoji string). */
  icon: string;
  /** True for screens whose routes admit only INVENTORY_MANAGER. */
  managerOnly?: boolean;
}

export const INVENTORY_NAV_LINKS: readonly InventoryNavLink[] = [
  { name: "Org Inventory", href: "/inventory/org-items", icon: "🏷️" },
  { name: "Locations", href: "/inventory/locations", icon: "📍" },
  { name: "Receive Queue", href: "/inventory/receive-queue", icon: "🚚" },
  { name: "Applied Deltas", href: "/inventory/received-deltas", icon: "🧾" },
  { name: "Merge Conflicts", href: "/inventory/merge-conflicts", icon: "⚠️", managerOnly: true },
  { name: "Provisional Map", href: "/inventory/provisional-items", icon: "🧩", managerOnly: true },
  { name: "Org Events", href: "/inventory/org-events", icon: "📨", managerOnly: true },
];
