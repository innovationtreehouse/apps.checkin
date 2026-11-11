/**
 * Nav descriptor for workflow-mapping. The library declares its screen; the host
 * places it as a tab in its Inventory section and supplies the viewer gate.
 */

export interface WorkflowMappingNavLink {
  name: string;
  href: string;
}

export const RECEIVING_NAV: WorkflowMappingNavLink = { name: "Part mapping", href: "/inventory/receiving" };
