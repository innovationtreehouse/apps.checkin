/**
 * Section gate for Settings (settings/layout.tsx). The layout, the left-nav
 * entry (AppFrame) and the /index directory read this one array, so the gate
 * has a single definition and cannot drift (#1569).
 *
 * Per-page gates are stricter and stay on each page (localization is sysadmin,
 * email/webhook/membership are board, outreach is board-or-operations); this is
 * only the outer "may enter the section at all" gate.
 */
import type { BusinessRole } from "@/types/auth";

export const SETTINGS_SECTION_ROLES: BusinessRole[] = [
  "isSysadmin",
  "isBoardMember",
  "isOperations",
];
