import type { OrgMembershipStatus, PersonRoleKind } from "@/generated/prisma/client";

/**
 * The part of `BackgroundCheckAttestation`'s
 * `@@unique([processId, reviewerId, subjectPersonId])` that a `subjectPersonId`
 * repoint does NOT change — two rows sharing it cannot both name the same
 * subject. The merge and its analyze preview share this one definition so
 * their collision keys cannot drift apart.
 */
export function bgSubjectKey(a: { processId: number; reviewerId: number }): string {
    return `${a.processId}:${a.reviewerId}`;
}

/** A household with no OrgMembership row has never been a Treehouse Member. */
export function householdMembershipStatus(
    household: { orgMembership?: { status: OrgMembershipStatus } | null } | null | undefined,
): OrgMembershipStatus {
    return household?.orgMembership?.status ?? "NONE";
}

/** Negative state: these restrict a household rather than granting it anything. */
function isRestricted(status: OrgMembershipStatus): boolean {
    return status === "DENIED" || status === "REVOKED";
}

export type MergeSubjectMembership = {
    status: OrgMembershipStatus;
    /** Live (un-merged) members of this household other than the merge subject itself. */
    liveOthers: number;
};

/**
 * Why this merge must be refused on household membership grounds, or null.
 *
 * OrgMembership is 1:1 with Household and a merge never moves it: the tombstone
 * keeps its householdId and the keeper stays in its own household. Two harms
 * follow, and both are asymmetric — which side is merged away decides them.
 *
 * 1. A restriction on one side only. `denied` is derived live from the person's
 *    CURRENT household (lib/authClaims.ts), so merging across a DENIED/REVOKED
 *    boundary changes which restriction the surviving human carries.
 * 2. An ACTIVE membership left with no live member. Only ACTIVE carries value
 *    worth stranding — NONE grants nothing and DENIED/REVOKED are negative
 *    state, so a live-empty household in those states strands nothing.
 *
 * A duplicate sitting alone in its own membership-less household — what every
 * fresh Google sign-in gets from createParticipantWithHousehold — is the
 * ordinary dedupe, and stays mergeable into a keeper of any status.
 */
export function membershipMergeBlock(
    keep: { status: OrgMembershipStatus },
    merge: MergeSubjectMembership,
): string | null {
    if (keep.status !== merge.status && (isRestricted(keep.status) || isRestricted(merge.status))) {
        return `Cannot merge: the kept record's household is ${keep.status} and the merged-away record's household is ${merge.status}. Login and facility access are read from the surviving record's household, so this merge would change which restriction applies to this person. Settle that first — assign the person to the right household from the Participants page, or set the household's membership on the Households page — then merge.`;
    }

    if (merge.status === "ACTIVE" && merge.liveOthers === 0) {
        return `Cannot merge: the merged-away record is the last live member of a household holding an ACTIVE Treehouse membership, and the kept record is in a different household (${keep.status}). The merge would leave that membership with nobody in it. Swap which record is kept, or assign the kept record to that household from the Participants page, then merge.`;
    }

    return null;
}

/**
 * Why moving the merged-away record's roles onto the keeper must be refused, or
 * null. The merge moves each role with `setRoleFlag` (revoke from the tombstone,
 * grant to the keeper), so it must pass that function's refusals; checking them
 * here refuses the merge before anything is written. The own-household rule is
 * prepareMerge's household conflict check.
 */
export function roleMergeBlock(
    actor: { isBoardMember?: boolean } | null,
    mergeRoles: PersonRoleKind[],
    keepRoles: PersonRoleKind[],
    keepStatus: OrgMembershipStatus,
): { status: 403 | 409; error: string } | null {
    if (mergeRoles.length === 0) return null;
    if (!actor) return { status: 403, error: "Forbidden" };
    if (mergeRoles.includes("KEY_VOLUNTEER") && !actor.isBoardMember) {
        return { status: 403, error: "Cannot merge: the merged-away record holds the Key Volunteer role, and only board members can grant or remove it." };
    }
    if (!mergeRoles.includes("BOARD")) return null;
    if (!actor.isBoardMember) {
        return { status: 403, error: "Cannot merge: the merged-away record holds the board role, and only board members can remove board membership." };
    }
    if (!keepRoles.includes("BOARD") && keepStatus === "DENIED") {
        return { status: 409, error: "Cannot merge: the merged-away record holds the board role, and the kept record's household has been denied membership. Restore the household's membership first." };
    }
    return null;
}
