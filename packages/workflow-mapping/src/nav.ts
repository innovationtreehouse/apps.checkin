/**
 * Nav descriptor for receipt mapping (#1289 §7). The library declares its
 * screen; the host places it as the Inventory area's "Receiving" tab and gates
 * it to the read roles (INVENTORY_MANAGER, FINANCE, BOARD).
 */
export interface WorkflowNavLink {
  name: string;
  href: string;
  /** Emoji icon (the host's SectionTabs render an emoji string). */
  icon: string;
}

export const RECEIVING_NAV_LINK: WorkflowNavLink = { name: "Receiving", href: "/inventory/receiving", icon: "📥" };
