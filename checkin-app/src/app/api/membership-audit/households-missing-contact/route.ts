import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { withAuth } from "@/lib/auth";
import { findHouseholdsMissingValidContact } from "@/lib/emergencyContacts/service";

export const dynamic = "force-dynamic";

/**
 * Active / in-intake households with no valid emergency contact, hydrated with
 * their leads so the Membership Audit view can show who to chase. The "missing
 * contact" predicate is owned by the emergency-contacts service — this route
 * only hydrates the ids it returns.
 */
export const GET = withAuth({ roles: ["isSysadmin", "isBoardMember"] }, async () => {
    const ids = await findHouseholdsMissingValidContact();
    if (ids.length === 0) return NextResponse.json({ households: [] });

    const households = await prisma.household.findMany({
        where: { id: { in: ids } },
        include: {
            householdMembers: {
                where: { isHouseholdLead: true },
                select: { id: true, name: true, phone: true, email: true },
            },
        },
        orderBy: { name: "asc" },
    });

    const result = households.map((h) => ({
        id: h.id,
        name: h.name,
        leads: h.householdMembers.map((p) => ({
            id: p.id,
            name: p.name,
            phone: p.phone,
            email: p.email,
        })),
    }));

    return NextResponse.json({ households: result });
});
