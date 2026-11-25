import prisma from "@/lib/prisma";
import { settledThisCycleWhere } from "@/lib/membership/lifecycle";
import { notRenewingTargetYear } from "@/lib/membership/notRenewing";
import { orgToday } from "@/lib/appSettings";
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
 * Who a renewal email sent at `now` may go to: a lead of a live, ACTIVE household with no
 * not-renewing note for the year the email is about. The reminder also skips a household
 * that has completed renewal for that year; a paid renewal waiting on its background check
 * has not. `archivedAt` is checked here because row security hides an archived household
 * only from queries that reach Household.
 */
export function outreachAudienceWhere(emailType: EmailType, boundary: Date | null | undefined, today: Date): Prisma.PersonWhereInput {
    const year = notRenewingTargetYear(boundary, today);
    const where: Prisma.PersonWhereInput = {
        isHouseholdLead: true,
        household: {
            archivedAt: null,
            orgMembership: {
                status: "ACTIVE",
                ...(year !== null && { OR: [{ notRenewingYear: null }, { notRenewingYear: { not: year } }] }),
            },
        },
    };
    if (emailType === "opening") return where;
    return {
        AND: [
            where,
            { NOT: { household: { orgMembership: { processes: { some: { AND: [settledThisCycleWhere(year), { status: "ACTIVE" }] } } } } } },
        ],
    };
}

/** {@link outreachAudienceWhere} for the Board's configured membership-year boundary. */
export async function outreachAudienceAt(emailType: EmailType, now: Date): Promise<Prisma.PersonWhereInput> {
    const settings = await prisma.boardSettings.findUnique({ where: { id: 1 }, select: { orgMembershipYearBoundary: true } });
    return outreachAudienceWhere(emailType, settings?.orgMembershipYearBoundary, await orgToday(now));
}

/** The recipients of one campaign send: the audience its email type implies. */
export async function computeRecipientSnapshot(emailType: EmailType, now = new Date()): Promise<RecipientSnapshot> {
    const where = await outreachAudienceAt(emailType, now);

    const [leadsWithoutEmail, leads] = await Promise.all([
        prisma.person.count({ where: { ...where, email: null } }),
        prisma.person.findMany({ where: { ...where, email: { not: null } }, select: { id: true, email: true } }),
    ]);

    const items = leads.flatMap((lead) => (lead.email ? [{ personId: lead.id, email: lead.email }] : []));
    return { items, leadsWithoutEmail };
}
