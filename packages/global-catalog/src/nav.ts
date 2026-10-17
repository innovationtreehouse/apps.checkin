/**
 * Nav descriptors for the catalog (#1286 §7). The library declares its screens
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
}

/** The section tabs under the Inventory entry (rendered by checkin's SectionTabs). */
export const CATALOG_NAV_LINKS: readonly CatalogNavLink[] = [
  { name: "Items", href: "/catalog/items", icon: "📦" },
  { name: "Categories", href: "/catalog/categories", icon: "🗂️" },
  { name: "Proposals", href: "/catalog/proposals", icon: "📥" },
  { name: "Conversion Challenges", href: "/catalog/conversion-challenges", icon: "⚖️" },
];

/** The top-level sidebar entry checkin splices into NAV_ITEMS (icon is checkin's). */
export const CATALOG_TOP_NAV = {
  href: "/catalog/items",
  label: "Inventory",
} as const;
