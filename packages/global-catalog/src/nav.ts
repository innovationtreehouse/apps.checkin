/**
 * Nav descriptors for the catalog. The library declares its screens
 * (labels, hrefs, section-tab icons) and the top-level entry's label/href; the
 * host (checkin) PLACES them — it decides sidebar order, supplies the top-level
 * icon component, and supplies the viewer predicate. The library never dictates
 * sidebar order and never imports the host.
 */

export interface CatalogNavLink {
  name: string;
  href: string;
  /** Emoji icon (checkin's SectionTabs render an emoji string). */
  icon: string;
  /** True for screens whose routes admit only INVENTORY_MANAGER. */
  managerOnly?: boolean;
  /** Screens grouped under this tab, shown as a second tab row; the tab opens the first. */
  subLinks?: readonly Omit<CatalogNavLink, "subLinks">[];
}

/** The section tabs under the Inventory entry (rendered by checkin's SectionTabs). */
export const CATALOG_NAV_LINKS: readonly CatalogNavLink[] = [
  {
    name: "Global Catalog",
    href: "/catalog/items",
    icon: "📦",
    subLinks: [
      { name: "Items", href: "/catalog/items", icon: "📦" },
      { name: "Categories", href: "/catalog/categories", icon: "🗂️" },
      { name: "Learned References", href: "/catalog/learned-references", icon: "🔗", managerOnly: true },
      { name: "Provisional Items", href: "/catalog/provisional-items", icon: "🧩", managerOnly: true },
      { name: "Item Reference Proposals", href: "/catalog/item-reference-proposals", icon: "📥", managerOnly: true },
      { name: "Reference Conflicts", href: "/catalog/reference-conflicts", icon: "⚠️", managerOnly: true },
      { name: "Conversion Challenges", href: "/catalog/conversion-challenges", icon: "⚖️", managerOnly: true },
    ],
  },
];

/** The top-level sidebar entry checkin splices into NAV_ITEMS (icon is checkin's). */
export const CATALOG_TOP_NAV = {
  href: "/catalog/items",
  label: "Inventory",
} as const;
