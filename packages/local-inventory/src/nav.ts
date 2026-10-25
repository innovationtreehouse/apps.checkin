/**
 * Nav descriptors for org inventory. The library declares its
 * screens; the host places them in its Inventory section tabs, orders them,
 * and hides the manager-only and receiving ones from viewers.
 */

export interface InventoryNavLink {
  name: string;
  href: string;
  /** Emoji icon (the host's SectionTabs render an emoji string). */
  icon: string;
  /** True for screens whose routes admit only INVENTORY_MANAGER. */
  managerOnly?: boolean;
  /** True for receiving screens, whose routes admit INVENTORY_MANAGER, FINANCE or BOARD. */
  receiving?: boolean;
  /** Screens grouped under this tab, shown as a second tab row; the tab opens the first. */
  subLinks?: readonly Omit<InventoryNavLink, "subLinks">[];
}

export const INVENTORY_NAV_LINKS: readonly InventoryNavLink[] = [
  {
    name: "Org Inventory",
    href: "/inventory/org-items",
    icon: "🏷️",
    subLinks: [
      { name: "All inventory", href: "/inventory/org-items", icon: "🏷️" },
      { name: "Needs a location", href: "/inventory/unlocated", icon: "❔", managerOnly: true },
      { name: "Receive queue", href: "/inventory/receive-queue", icon: "🚚", receiving: true },
      { name: "Locations", href: "/inventory/locations", icon: "📍" },
      { name: "Inventory log", href: "/inventory/inventory-log", icon: "📜", receiving: true },
    ],
  },
  { name: "Applied Deltas", href: "/inventory/received-deltas", icon: "🧾", receiving: true },
  { name: "Merge Conflicts", href: "/inventory/merge-conflicts", icon: "⚠️", managerOnly: true },
  { name: "Provisional Map", href: "/inventory/provisional-items", icon: "🧩", managerOnly: true },
  { name: "Org Events", href: "/inventory/org-events", icon: "📨", managerOnly: true },
];
