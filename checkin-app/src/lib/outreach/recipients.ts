import prisma from "@/lib/prisma";
import { liveMembershipYear } from "@/lib/membership/renewal";
import { settledThisCycleWhere } from "@/lib/membership/lifecycle";
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
 * won't renew into the live year, the one renewals buy. `archivedAt` is checked here because row
 * security hides an archived household only from queries that reach Household.
 */
function audienceWhere(emailType: EmailType, liveYear: number | null): Prisma.PersonWhereInput {
    const where: Prisma.PersonWhereInput = {
        isHouseholdLead: true,
        household: {
            archivedAt: null,
            orgMembership: {
                status: "ACTIVE",
                ...(liveYear !== null && { OR: [{ notRenewingYear: null }, { notRenewingYear: { not: liveYear } }] }),
            },
        },
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
    const where = audienceWhere(emailType, liveMembershipYear(settings?.orgMembershipYearBoundary, now));

    const [leadsWithoutEmail, leads] = await Promise.all([
        prisma.person.count({ where: { ...where, email: null } }),
        prisma.person.findMany({ where: { ...where, email: { not: null } }, select: { id: true, email: true } }),
    ]);

    const items = leads.flatMap((lead) => (lead.email ? [{ personId: lead.id, email: lead.email }] : []));
    return { items, leadsWithoutEmail };
}
