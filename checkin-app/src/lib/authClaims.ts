import type { JWT } from "next-auth/jwt";
import type { OrgMembershipStatus, PersonRoleKind } from "@/generated/prisma/client";
import { orgMembershipStatusBlocksLogin, personRecordIsActiveOrgMember } from "@/lib/orgMembership";
import { ageBand } from "@/lib/programAge";
import { ROLE_FLAGS, rolesToFlags } from "@/lib/roles";

/** The participant fields the JWT carries, plus the household membership the login gate reads. */
export type ClaimSourceParticipant = {
    id: number;
    name?: string | null;
    // Their first sign-in's household question is open (lib/household/joinQuestion.ts).
    householdJoinPending?: boolean;
    // Source of truth for the five authority booleans (see lib/roles.ts rolesToFlags).
    roles: { role: PersonRoleKind }[];
    householdId: number;
    toolStatuses: { toolId: number; level: string }[];
    // Leadership of their own household. Single source of truth (a1) — supersedes
    // the former HouseholdLead join.
    isHouseholdLead: boolean;
    // Age inputs for the isKnownAdult claim. Both are plain Person scalars the
    // callback already loads; only the derived boolean reaches the token.
    dateOfBirth: Date | null;
    isDeclaredAdult: boolean;
    // Programs this participant is the lead mentor of (Program.leadMentorId === id).
    // Drives the client-side program-ops row gate; mirrors access-resolvers' programsLed.
    programsLed?: { id: number }[];
    // Any ProgramVolunteer row on an unfinished program makes this person a Program Volunteer; one is enough.
    programVolunteers?: unknown[];
    household?: { orgMembership?: { status: OrgMembershipStatus; isVolunteerFamily?: boolean } | null } | null;
    // ops-stg access gate escape hatch — a plain Person column, NOT one of the
    // PersonRole-backed flags above (sysadmin-settable only; see lib/roles.ts).
    canAccessStaging: boolean;
};

/**
 * Stamp a participant's authority claims onto the JWT, applying the household login gate.
 *
 * Single source of truth shared by both jwt-callback branches (fresh sign-in and per-request
 * refresh). When the household membership is DENIED the account is locked out: the id is kept
 * (so the session still resolves and the /access-denied gate can identify the state) but every
 * authority flag is forced false and tool statuses are cleared, so nothing downstream honors it.
 */
export function assignParticipantClaims(token: JWT, p: ClaimSourceParticipant): void {
    const denied = orgMembershipStatusBlocksLogin(p.household?.orgMembership?.status);
    const pending = p.householdJoinPending === true;
    const f = rolesToFlags(p.roles);

    token.id = p.id;
    token.denied = denied;
    token.householdJoinPending = pending;
    // Nothing from the record reaches someone who has not said it is theirs.
    const locked = denied || pending;
    if (pending) token.name = null;
    else token.name ??= p.name;
    for (const flag of ROLE_FLAGS) {
        token[flag] = locked ? false : f[flag];
    }
    token.householdId = pending ? null : p.householdId;
    token.householdLead = locked ? false : p.isHouseholdLead;
    // Derived band, never the DOB itself. Not a role, so DENIED doesn't clear
    // it — age is a fact about the person, not an authority grant.
    token.ageBand = pending ? "unknown" : ageBand(p);
    token.toolStatuses = locked ? [] : p.toolStatuses;
    token.programsLed = locked ? [] : (p.programsLed?.map((prog) => prog.id) ?? []);
    // ops-stg access gate escape hatch — forced false on DENIED, same as every role flag.
    token.canAccessStaging = locked ? false : p.canAccessStaging;
    // Treehouse Volunteer inputs (lib/volunteer.ts), forced false on DENIED.
    token.isProgramVolunteer = !locked && (p.programVolunteers?.length ?? 0) > 0;
    token.isVolunteerFamily = !locked && p.household?.orgMembership?.isVolunteerFamily === true;
    token.isActiveOrgMember = !locked && personRecordIsActiveOrgMember(p);
}
