import { ORG_DOMAIN } from "@/lib/config";
import type { AgeBand } from "@/lib/programAge";
import { ROLE_FLAGS, type RoleFlag } from "@/lib/roles";

/** The session claims the volunteer predicates read. All are stamped by the jwt callback. */
export type VolunteerClaims = Partial<Record<RoleFlag, boolean>> & {
    email?: string | null;
    hd?: string | null;
    emailVerified?: boolean;
    ageBand?: AgeBand;
    programsLed?: number[];
    isProgramVolunteer?: boolean;
    isVolunteerFamily?: boolean;
    isActiveOrgMember?: boolean;
};

/**
 * A staff account: Google-verified on the org's hosted domain. The address must
 * be on the domain too, because a dev persona mint carries the org gate claims
 * while keeping the persona's own address.
 */
function isStaffAccount(c: VolunteerClaims): boolean {
    return c.hd === ORG_DOMAIN && c.emailVerified === true && !!c.email?.toLowerCase().endsWith(`@${ORG_DOMAIN}`);
}

/** Volunteering through a program or a Volunteer Family, while the household membership is ACTIVE. Any age. */
function volunteersAsMember(c: VolunteerClaims): boolean {
    if (c.isActiveOrgMember !== true) return false;
    return (c.programsLed?.length ?? 0) > 0 || c.isProgramVolunteer === true || c.isVolunteerFamily === true;
}

/**
 * The one definition of a Treehouse Volunteer, an adult (docs/VOCABULARY.md).
 * Role holders and staff accounts qualify outright; a program leader, program
 * volunteer, or Volunteer Family member qualifies as a known adult whose
 * household membership is ACTIVE. Never keyed on an email address.
 */
export function isTreehouseVolunteer(c: VolunteerClaims | undefined): boolean {
    if (!c) return false;
    if (ROLE_FLAGS.some((flag) => c[flag] === true)) return true;
    if (isStaffAccount(c)) return true;
    return c.ageBand === "adult" && volunteersAsMember(c);
}

/**
 * Who may see the catalog and org inventory: every Treehouse Volunteer, and any
 * youth who would be one but for their age.
 */
export function canSeeCatalog(c: VolunteerClaims | undefined): boolean {
    return isTreehouseVolunteer(c) || (!!c && volunteersAsMember(c));
}
