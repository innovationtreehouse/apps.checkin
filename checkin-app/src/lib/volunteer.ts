import { ORG_DOMAIN } from "@/lib/config";
import { ROLE_FLAGS, type RoleFlag } from "@/lib/roles";

/** The session claims the Treehouse Volunteer definition reads. All are stamped by the jwt callback. */
export type VolunteerClaims = Partial<Record<RoleFlag, boolean>> & {
    email?: string | null;
    hd?: string | null;
    emailVerified?: boolean;
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

/**
 * The one definition of a Treehouse Volunteer (docs/VOCABULARY.md). Role holders
 * and staff accounts qualify outright; a program leader, program volunteer, or
 * member of a Volunteer Family (youth included) qualifies only while their
 * household membership is active. Never keyed on an email address.
 */
export function isTreehouseVolunteer(c: VolunteerClaims | undefined): boolean {
    if (!c) return false;
    if (ROLE_FLAGS.some((flag) => c[flag] === true)) return true;
    if (isStaffAccount(c)) return true;
    if (c.isActiveOrgMember !== true) return false;
    return (c.programsLed?.length ?? 0) > 0 || c.isProgramVolunteer === true || c.isVolunteerFamily === true;
}
