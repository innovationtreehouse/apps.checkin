import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import prisma from "@/lib/prisma";
import { withAuth } from "@/lib/auth";
import { apiError } from "@/lib/api-response";
import { BROKEN_HOUSEHOLD_WHERE } from "@/lib/household/filters";
import { LIVE_PERSON } from "@/lib/person/filters";

export const dynamic = "force-dynamic";

// "Broken" households have live members but no household lead among them.
// Most arrive this way via Zoho import without a designated primary contact —
// a registered family that nobody can claim, because claiming requires a lead.
export const GET = withAuth(
    { roles: ["isSysadmin", "isBoardMember"] },
    async () => {
        try {
            const households = await prisma.household.findMany({
                where: BROKEN_HOUSEHOLD_WHERE,
                include: {
                    householdMembers: {
                        where: LIVE_PERSON,
                        select: { id: true, name: true, dateOfBirth: true },
                        orderBy: { id: "asc" },
                    },
                },
                orderBy: { name: "asc" },
            });

            const result = households.map(h => ({
                id: h.id,
                name: h.name || `Household #${h.id}`,
                members: h.householdMembers.map(p => ({ id: p.id, name: p.name, dateOfBirth: p.dateOfBirth })),
            }));

            return NextResponse.json({ households: result });
        } catch (error) {
            logger.error("Failed to fetch broken households:", error);
            return apiError("Failed to fetch broken households", 500);
        }
    }
);
