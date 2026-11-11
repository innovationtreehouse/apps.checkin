/**
 * The sidebar entries every signed-in person sees (and Programs, which is
 * public), plus the Personal pages whose gate is narrower than signed-in.
 */
import type { RoleFlag } from "@/lib/roles";
import type { NavGate, NavSection } from "@/lib/nav/types";
import { SYSADMIN_OR_BOARD, anyRole, everyone, signedIn } from "@/lib/nav/gates";

export const MY_HOUSEHOLD: NavSection = { id: "my-household", label: "My Household", href: "/my-household", links: [], visible: signedIn };
export const ATTENDANCE: NavSection = { id: "attendance", label: "Attendance", href: "/attendance", links: [], visible: signedIn };
export const PROGRAMS: NavSection = { id: "programs", label: "Programs", href: "/programs", links: [], visible: everyone };
export const COMMUNICATION: NavSection = { id: "communication", label: "Communication", href: "/communication", links: [], visible: signedIn };
export const INDEX: NavSection = { id: "index", label: "Index", href: "/index", links: [], visible: signedIn };

/** Trusted-adult management belongs to the household lead, not every household member. */
export const isHouseholdLead: NavGate = (u) => u?.householdLead === true;

/** Who reads the tool-certification grid off the kiosk; /api/kioskdisplay/certifications checks the same roles. */
export const CERTIFICATION_GRID_ROLES = [...SYSADMIN_OR_BOARD, "isKeyholder"] as const satisfies readonly RoleFlag[];
export const seesCertificationGrid: NavGate = anyRole(CERTIFICATION_GRID_ROLES);
