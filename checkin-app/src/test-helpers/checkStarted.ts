import prisma from "@/lib/prisma";
import { markCheckStarted } from "@/lib/membership/checkStarted";

/**
 * Integration-test helper: a household application's lead marks their own check
 * started, the way /membership does. `lead` picks among the household's leads by id
 * order. Returns the lead's id.
 */
export async function markLeadCheckStarted(applicationId: number, lead = 0): Promise<number> {
    const app = await prisma.orgMembershipProcess.findUniqueOrThrow({ where: { id: applicationId }, select: { orgMembership: { select: { householdId: true } } } });
    const leads = await prisma.person.findMany({ where: { householdId: app.orgMembership!.householdId, isHouseholdLead: true }, orderBy: { id: "asc" }, select: { id: true } });
    const leadId = leads[lead].id;
    await markCheckStarted(leadId, leadId);
    return leadId;
}

