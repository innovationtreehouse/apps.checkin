import prisma from "@/lib/prisma";
import { liveMembershipYear } from "@/lib/membership/renewal";
import { settledThisCycleWhere } from "@/lib/membership/lifecycle";
import { notRenewingTargetYear } from "@/lib/membership/notRenewing";
import type { Prisma } from "@/generated/prisma/client";
import type { EmailType } from "@/lib/outreach/render";

export interface RecipientSnapshotItem {
    personId: number;
    email: string;
}

export interface RecipientSnapshot {
    items: RecipientSnapshotItem[];
    /** Leads in the email type's audience with no email — informational only, they get no item. */
    leadsWithoutEmail: number;
}

/**
 * Renewal outreach goes only to leads of live households whose membership is ACTIVE,
 * which also rules out a DENIED household, and skips a household that has said it
 * won't renew into the noted year. `archivedAt` is checked here because row
 * security hides an archived household only from queries that reach Household.
 */
function audienceWhere(emailType: EmailType, liveYear: number | null, notRenewingYear: number | null): Prisma.PersonWhereInput {
    const where: Prisma.PersonWhereInput = {
        isHouseholdLead: true,
        household: { archivedAt: null, orgMembership: { status: "ACTIVE" } },
        ...(notRenewingYear !== null && { NOT: { household: { orgMembership: { notRenewingYear } } } }),
    };
    if (emailType === "opening") return where;
    // The reminder skips a household that has completed renewal for the year a renewal
    // buys now. A paid renewal still waiting on its background check is not complete.
    return {
        AND: [
            where,
            { NOT: { household: { orgMembership: { processes: { some: { AND: [settledThisCycleWhere(liveYear), { status: "ACTIVE" }] } } } } } },
        ],
    };
}

/** The recipients of one campaign send: the audience its email type implies. */
export async function computeRecipientSnapshot(emailType: EmailType, now = new Date()): Promise<RecipientSnapshot> {
    const settings = await prisma.boardSettings.findUnique({ where: { id: 1 }, select: { orgMembershipYearBoundary: true } });
    const boundary = settings?.orgMembershipYearBoundary;
    const where = audienceWhere(emailType, liveMembershipYear(boundary, now), notRenewingTargetYear(boundary, now));

    const [leadsWithoutEmail, leads] = await Promise.all([
        prisma.person.count({ where: { ...where, email: null } }),
        prisma.person.findMany({ where: { ...where, email: { not: null } }, select: { id: true, email: true } }),
    ]);

    const items = leads.flatMap((lead) => (lead.email ? [{ personId: lead.id, email: lead.email }] : []));
    return { items, leadsWithoutEmail };
}
