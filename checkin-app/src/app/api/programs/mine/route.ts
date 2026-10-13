import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import type { Session } from "next-auth";
import { withAuth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { activityMembers } from "@/lib/household/activityMembers";
import { apiError } from "@/lib/api-response";
import { seesHouseholdPaymentStatus } from "@/lib/programs/paymentVisibility";

export const GET = withAuth({}, async (_req, auth) => {
    if (auth.type !== 'session') return apiError("Unauthorized", 401);
    // activityMembers only reads session.user; reconstruct the minimal shape from auth.user.
    const session = { user: auth.user } as unknown as Session;

    try {
        // Self, or every household member when the session is a household lead.
        const householdMembers = await activityMembers(session);
        const householdMemberIds = householdMembers.map(m => m.id);

        const enrollments = await prisma.programParticipant.findMany({
            where: { personId: { in: householdMemberIds } },
            select: {
                programId: true,
                personId: true,
                status: true,
                isPaymentPlanRequested: true,
                person: { select: { id: true, name: true } },
                program: {
                    select: { id: true, name: true, startAt: true, endAt: true }
                }
            },
            orderBy: { program: { startAt: "asc" } }
        });

        if (await seesHouseholdPaymentStatus(auth.user.id)) return NextResponse.json(enrollments);
        return NextResponse.json(enrollments.map(({ programId, personId, person, program }) => ({ programId, personId, person, program })));
    } catch (error) {
        logger.error("Failed to fetch user programs:", error);
        return apiError("Failed to fetch programs", 500);
    }
});
