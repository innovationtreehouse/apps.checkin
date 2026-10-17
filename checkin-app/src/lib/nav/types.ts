/**
 * Shared shape for a section-nav link (the persistent top tabs). Each section
 * keeps its own data array (FACILITY_NAV_LINKS etc.) — only the link type is shared.
 *
 * Sections that gate tabs extend this with their own field: shopNav adds a
 * required `visible` predicate.
 */
export interface NavLink {
  name: string;
  href: string;
  icon: string;
}
