/**
 * Section gate for the Safety tools (safety/layout.tsx tabs). The layout, the
 * left-nav entry (AppFrame) and the /index directory all read this one array,
 * so the section gate has a single definition and cannot drift (#1569).
 *
 * The per-tab gate (Trusted Adults is board-only) stays in the layout: it is a
 * tab filter, not a separately routed page.
 */
import type { BusinessRole } from "@/types/auth";

export const SAFETY_SECTION_ROLES: BusinessRole[] = [
  "isSysadmin",
  "isBoardMember",
  "isKeyholder",
];
