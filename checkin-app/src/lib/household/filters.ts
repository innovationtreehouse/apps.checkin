import type { Prisma } from "@/generated/prisma/client";
import { LIVE_PERSON } from "@/lib/person/filters";

/**
 * Shared Household `where` fragments for the "who needs a lead" surfaces (a1:
 * leadership is `Person.isHouseholdLead`). These were copy-pasted across the
 * broken-households admin list, the membership-audit unclaimed list, and the nav
 * todo-count badge — with a comment begging them to stay in sync. Define once so
 * the list and its count can't diverge.
 *
 * Membership is counted in LIVE people only (`LIVE_PERSON`). A merged-away member
 * keeps its householdId, so without the filter a household whose last live member
 * was merged away reads as "has members, no lead" forever — an unclearable board
 * to-do, since the only name to promote is a tombstone.
 */

/**
 * "Broken": has at least one live member, none of whom is a lead. A household with
 * no live members is NOT broken — there is nobody to promote.
 */
export const BROKEN_HOUSEHOLD_WHERE: Prisma.HouseholdWhereInput = {
    householdMembers: { some: LIVE_PERSON, none: { isHouseholdLead: true, ...LIVE_PERSON } },
};

/**
 * Households to chase on the membership audit / nav badge:
 *   1. Unclaimed-with-lead: a lead has an email to chase, but no lead has signed in
 *      with Google yet (a claimed lead covers the whole household).
 *   2. Broken: no lead at all — no email requirement (may have no contactable member).
 * The audit list route and the nav count MUST use this same predicate or they drift.
 *
 * "Signed in" is the Account row, NOT `Person.googleId`. googleId is only written on
 * the new-user path (auth-options createUser, off the Google profile); an imported
 * Person matched by email links via allowDangerousEmailAccountLinking, which writes
 * only an Account and never backfills googleId. Keying off googleId therefore left
 * every imported household — exactly the population this list chases — permanently
 * unclaimed no matter how many times its lead signed in. Account covers both paths
 * (createUser is followed by linkAccount) and survives a participant merge, which
 * reassigns Account.userId unconditionally while googleId only moves if the conflict
 * picker chose it.
 */
export const UNCLAIMED_OR_BROKEN_HOUSEHOLD_WHERE: Prisma.HouseholdWhereInput = {
    OR: [
        {
            householdMembers: { some: { isHouseholdLead: true, email: { not: null }, ...LIVE_PERSON } },
            NOT: { householdMembers: { some: { isHouseholdLead: true, accounts: { some: { provider: "google" } }, ...LIVE_PERSON } } },
        },
        BROKEN_HOUSEHOLD_WHERE,
    ],
};
