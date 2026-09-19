import type { OrgMembershipStatus, Prisma } from "@/generated/prisma/client";
import prisma from "@/lib/prisma";
import { membershipYearCycle, coveredThrough } from "@/lib/membership/renewal";
import { duesSettledAwaitingBg, settledThisCycleWhere } from "@/lib/membership/lifecycle";

/**
 * Canonical "is this person an active Treehouse Member?" read model.
 *
 * Each household has one Membership (1:1). A Person counts as an active org
 * member when their household's membership has status ACTIVE. This is the single
 * source of truth for org-member gating — route every "is org member?" check
 * through here so a child or second parent in an active household is honored.
 */
export const ACTIVE_ORG_MEMBER_PERSON_WHERE: Prisma.PersonWhereInput = {
    household: { orgMembership: { status: "ACTIVE" } },
};

/**
 * Does the Person with this id currently count as an active Treehouse Member?
 * One indexed existence check; returns false for unknown ids.
 */
export async function isActiveOrgMember(personId: number): Promise<boolean> {
    if (!Number.isInteger(personId)) return false;
    const match = await prisma.person.findFirst({
        where: { AND: [{ id: personId }, ACTIVE_ORG_MEMBER_PERSON_WHERE] },
        select: { id: true },
    });
    return match !== null;
}

/**
 * Pure predicate over an already-loaded Person record. Use when a query has
 * already pulled membership data and an
 * extra query would be wasteful. Accepts any record whose household carries its
 * membership; a missing household or membership reads as "not an org member".
 */
export function personRecordIsActiveOrgMember(p: {
    household?: { orgMembership?: { status: OrgMembershipStatus } | null } | null;
}): boolean {
    return p.household?.orgMembership?.status === "ACTIVE";
}

/**
 * PROGRAM ACCESS — "has this household settled its dues?", deliberately WIDER
 * than {@link ACTIVE_ORG_MEMBER_PERSON_WHERE}: it also matches a household whose
 * application is paid and waiting on background clearance
 * ({@link duesSettledAwaitingBg}). Such a household has paid in full and is
 * waiting on the board, so for programs it gets the member rate and sees
 * members-only programs, rather than being held at the non-member tier for the
 * review's duration (#1397).
 *
 * PROGRAMS ONLY. Do NOT reuse this for "is this a member": member-only mailing
 * audiences, outreach variants, the shop org-members list and every other
 * benefit stay ACTIVE-only, because ACTIVE is what encodes "background check
 * cleared". Facility access is likewise unaffected — nothing here admits an
 * uncleared adult to the building.
 */
export const DUES_SETTLED_PERSON_WHERE: Prisma.PersonWhereInput = {
    household: {
        orgMembership: {
            OR: [
                { status: "ACTIVE" },
                { processes: { some: duesSettledAwaitingBg.where } },
            ],
        },
    },
};

/**
 * Does this Person's household count as dues-settled for programs? See
 * {@link DUES_SETTLED_PERSON_WHERE} for why this isn't the same question as
 * {@link isActiveOrgMember}.
 */
export async function isDuesSettled(personId: number): Promise<boolean> {
    if (!Number.isInteger(personId)) return false;
    const match = await prisma.person.findFirst({
        where: { AND: [{ id: personId }, DUES_SETTLED_PERSON_WHERE] },
        select: { id: true },
    });
    return match !== null;
}

/**
 * Does this membership status lock every household member out of login?
 *
 * Only DENIED blocks login. REVOKED is a softer state — a former Treehouse Member
 * who keeps app access but loses facility privileges. This is the single source of
 * truth for the login gate; the auth jwt callback and middleware both route through
 * it so a board "Deny Membership" action takes effect for every member of the household.
 */
export function orgMembershipStatusBlocksLogin(
    status: OrgMembershipStatus | null | undefined,
): boolean {
    return status === "DENIED";
}

/**
 * How far a household's dues currently cover, as a boundary date — or null when
 * no horizon can be computed (dues not settled, or the board hasn't set
 * {@link BoardSettings.orgMembershipYearBoundary}). A membership always runs
 * boundary-to-boundary. A household settled for the live membership year
 * ({@link settledThisCycleWhere} — a paid INITIAL or RENEWAL stamped since the
 * year's renewal window opened) is covered to the boundary that closes the year;
 * one that did not settle is covered only to the boundary that opened it, so off
 * season it reads as lapsed. Coverage is what was bought: a membership with no
 * dues-paid process (a bare manual grant, an import) has bought nothing the app
 * can see. Same rule households-ops renders as valid-until.
 *
 * "Dues settled" here is {@link DUES_SETTLED_PERSON_WHERE}'s rule, so a paid
 * application still awaiting background clearance gets the same horizon. That
 * doesn't widen {@link isActiveOrgMemberThrough}, which gates on ACTIVE before
 * ever asking for a horizon.
 */
export async function membershipValidThrough(householdId: number, now = new Date()): Promise<Date | null> {
    const household = await prisma.household.findUnique({
        where: { id: householdId },
        select: {
            orgMembership: {
                select: {
                    id: true,
                    status: true,
                    processes: { where: duesSettledAwaitingBg.where, select: { id: true }, take: 1 },
                },
            },
        },
    });
    const membership = household?.orgMembership;
    if (!membership || (membership.status !== "ACTIVE" && !membership.processes?.length)) return null;

    const settings = await prisma.boardSettings.findUnique({
        where: { id: 1 },
        select: { orgMembershipYearBoundary: true },
    });
    if (!settings?.orgMembershipYearBoundary) return null;

    const cycle = membershipYearCycle(settings.orgMembershipYearBoundary, now);
    const settled = (await prisma.orgMembershipProcess.findFirst({
        where: { orgMembershipId: membership.id, ...settledThisCycleWhere(cycle.settledSince) },
        select: { id: true },
    })) !== null;

    return coveredThrough(cycle, settled);
}

/**
 * Does this Person's household coverage reach `through`? `through === null`
 * means the program has no dates to compare against, so status-only behavior
 * applies. When a horizon CAN'T be computed (no boundary configured) coverage
 * passes — preserves current behavior rather than penalizing every member for a
 * board settings gap. Callers gate on membership/dues status FIRST; this only
 * answers the duration half.
 */
async function coversThrough(personId: number, through: Date | null): Promise<boolean> {
    if (through === null) return true;

    const person = await prisma.person.findUnique({ where: { id: personId }, select: { householdId: true } });
    const validThrough = person ? await membershipValidThrough(person.householdId) : null;
    if (validThrough === null) return true;

    const throughDay = Date.UTC(through.getUTCFullYear(), through.getUTCMonth(), through.getUTCDate());
    const validDay = Date.UTC(validThrough.getUTCFullYear(), validThrough.getUTCMonth(), validThrough.getUTCDate());
    return validDay >= throughDay;
}

/** Does this Person's ACTIVE org membership cover a program running through `through`? */
export async function isActiveOrgMemberThrough(personId: number, through: Date | null): Promise<boolean> {
    return (await isActiveOrgMember(personId)) && coversThrough(personId, through);
}

/**
 * Are this Person's dues settled through a program running to `through`? Same
 * duration rule as {@link isActiveOrgMemberThrough}, over the wider
 * {@link DUES_SETTLED_PERSON_WHERE} population. This is the member-PRICING
 * question; the members-only visibility gate is status-only ({@link isDuesSettled}),
 * matching what it replaced.
 */
export async function isDuesSettledThrough(personId: number, through: Date | null): Promise<boolean> {
    return (await isDuesSettled(personId)) && coversThrough(personId, through);
}

/**
 * The date a program's member pricing must be valid through: its end date.
 * Both startAt and endAt are required on programs.
 */
export function programCoverageDate(p: { endAt: Date }): Date {
    return p.endAt;
}
