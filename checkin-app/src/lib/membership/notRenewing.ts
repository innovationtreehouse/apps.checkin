import prisma from "@/lib/prisma";
import { orgToday } from "@/lib/appSettings";
import type { TxClient } from "@/lib/db-client";
import { ServiceError } from "@checkin/component-kit";
import { config } from "@/lib/config";
import { personActor } from "@/lib/auditActor";
import { emailBoardMembers } from "@/lib/emailRecipients";
import { isYouth } from "@/lib/time";
import { orgToday } from "@/lib/appSettings";
import { lockLiveHouseholds } from "@/lib/household/archiveGuard";
import { RENEWAL_UNDERWAY, settledThisCycleWhere } from "@/lib/membership/lifecycle";
import { liveMembershipYear, membershipYearLabel, renewalWindow } from "@/lib/programYear";

/**
 * A household lead tells the Board the household won't renew into the year the
 * next renewal run opens. The note stops that year's renewal outreach and
 * changes nothing else; either lead may undo it, and confirming the renewal
 * clears it ({@link clearNotRenewingInTx}).
 */
export class NotRenewingError extends ServiceError {
    constructor(status: number, message: string, code: "not_lead" | "not_active" | "no_membership" | "already_renewed" | "renewal_underway" | "no_boundary") {
        super(status, message, code);
        this.name = "NotRenewingError";
    }
}

/** The noted year on `today`, an org calendar day: the live year inside the renewal window, the year after it outside. */
export function notRenewingTargetYear(boundary: Date | null | undefined, today: Date): number | null {
    const live = liveMembershipYear(boundary, today);
    if (!boundary || live === null) return null;
    return renewalWindow(boundary, today).inSeason ? live : live + 1;
}

/** True while the note's year has not passed: it is the live year or a later one. */
export function noteStands(notRenewingYear: number | null, boundary: Date | null | undefined, today: Date): notRenewingYear is number {
    const live = liveMembershipYear(boundary, today);
    return notRenewingYear !== null && live !== null && notRenewingYear >= live;
}

/** True when a RENEWAL application was opened for the year its household has said it won't renew into. */
export function isNotRenewingRenewal(
    row: { kind: string; createdAt: Date },
    notRenewingYear: number | null,
    boundary: Date | null | undefined,
): boolean {
    return row.kind === "RENEWAL" && notRenewingYear !== null && liveMembershipYear(boundary, row.createdAt) === notRenewingYear;
}

const LEAD_SELECT = { name: true, householdId: true, isHouseholdLead: true, dateOfBirth: true } as const;

function refuseNonLead(person: { isHouseholdLead: boolean; dateOfBirth: Date | null } | null, today: Date): asserts person {
    if (!person?.isHouseholdLead || isYouth(person.dateOfBirth, today)) {
        throw new NotRenewingError(403, "Only an adult household lead can say whether the household will renew.", "not_lead");
    }
}

async function leadOf(personId: number) {
    const person = await prisma.person.findUnique({ where: { id: personId }, select: LEAD_SELECT });
    refuseNonLead(person, await orgToday());
    return person;
}

/** Locks the live household, then confirms the caller is still an adult lead of it. */
async function lockAsLead(tx: TxClient, personId: number, householdId: number): Promise<void> {
    await lockLiveHouseholds(tx, [householdId]);
    const person = await tx.person.findUnique({ where: { id: personId }, select: LEAD_SELECT });
    refuseNonLead(person, await orgToday(new Date(), tx));
    if (person.householdId !== householdId) {
        throw new NotRenewingError(403, "Only an adult household lead can say whether the household will renew.", "not_lead");
    }
}

async function boundaryNow() {
    const settings = await prisma.boardSettings.findUnique({ where: { id: 1 }, select: { orgMembershipYearBoundary: true } });
    return settings?.orgMembershipYearBoundary ?? null;
}

/** Sets the note for the caller's household; a repeat is a no-op. Emails the Board after commit. */
export async function markNotRenewing(personId: number, now = new Date()) {
    const lead = await leadOf(personId);
    const year = notRenewingTargetYear(await boundaryNow(), await orgToday(now));
    if (year === null) throw new NotRenewingError(409, "The membership year isn't set up yet. Please contact the Board.", "no_boundary");

    const { membership, changed } = await prisma.$transaction(async (tx) => {
        const [locked] = await tx.$queryRaw<{ id: number; status: string }[]>`SELECT id, status FROM "OrgMembership" WHERE "householdId" = ${lead.householdId} FOR UPDATE`;
        if (locked?.status !== "ACTIVE") {
            throw new NotRenewingError(409, "Only an active membership can say it won't renew.", "not_active");
        }
        await lockAsLead(tx, personId, lead.householdId);
        const underway = await tx.orgMembershipProcess.findFirst({
            where: { orgMembershipId: locked.id, kind: "RENEWAL", status: { in: [...RENEWAL_UNDERWAY] } },
            select: { id: true },
        });
        if (underway) {
            throw new NotRenewingError(409, "Your household's renewal is already under way. Please talk to the Board.", "renewal_underway");
        }
        const paid = await tx.orgMembershipProcess.findFirst({
            where: { orgMembershipId: locked.id, ...settledThisCycleWhere(year) },
            select: { id: true },
        });
        if (paid) {
            throw new NotRenewingError(409, `Your household has already renewed for ${membershipYearLabel(year)}. Please talk to the Board.`, "already_renewed");
        }
        const { count } = await tx.orgMembership.updateMany({
            where: { id: locked.id, OR: [{ notRenewingYear: null }, { notRenewingYear: { not: year } }] },
            data: { notRenewingYear: year },
        });
        if (count === 1) {
            await tx.auditLog.create({
                data: { ...personActor(personId), action: "EDIT", tableName: "OrgMembership", affectedEntityId: locked.id, newData: { notRenewingYear: year } },
            });
        }
        return { membership: await tx.orgMembership.findUniqueOrThrow({ where: { id: locked.id } }), changed: count === 1 };
    });

    if (changed) {
        const household = await prisma.household.findUnique({ where: { id: lead.householdId }, select: { name: true } });
        await emailBoardMembers("board.notRenewing", {
            householdName: household?.name ?? `#${lead.householdId}`,
            personName: lead.name,
            year: membershipYearLabel(year),
            actionLink: `${config.baseUrl()}/membership-ops/households/${lead.householdId}`,
        }, "Not-renewing board ping failed:");
    }
    return membership;
}

/** Removes the note from the caller's household; a repeat is a no-op. */
export async function clearNotRenewing(personId: number) {
    const lead = await leadOf(personId);
    return prisma.$transaction(async (tx) => {
        const [membership] = await tx.$queryRaw<{ id: number }[]>`SELECT id FROM "OrgMembership" WHERE "householdId" = ${lead.householdId} FOR UPDATE`;
        if (!membership) throw new NotRenewingError(409, "Your household has no membership to change.", "no_membership");
        await lockAsLead(tx, personId, lead.householdId);
        await clearNotRenewingInTx(tx, membership.id, personId);
        return tx.orgMembership.findUniqueOrThrow({ where: { id: membership.id } });
    });
}

/** Clears any note on the membership inside the caller's transaction, with its audit row when one was set. */
export async function clearNotRenewingInTx(tx: TxClient, orgMembershipId: number, actorId: number): Promise<void> {
    const { count } = await tx.orgMembership.updateMany({
        where: { id: orgMembershipId, notRenewingYear: { not: null } },
        data: { notRenewingYear: null },
    });
    if (count === 1) {
        await tx.auditLog.create({
            data: { ...personActor(actorId), action: "EDIT", tableName: "OrgMembership", affectedEntityId: orgMembershipId, newData: { notRenewingYear: null } },
        });
    }
}
