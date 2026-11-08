import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import prisma from "@/lib/prisma";
import { withAuth } from "@/lib/auth";
import { apiError } from "@/lib/api-response";
import { UNCLAIMED_OR_BROKEN_HOUSEHOLD_WHERE } from "@/lib/household/filters";

export const dynamic = 'force-dynamic';

export const GET = withAuth(
    { roles: ['isSysadmin', 'isBoardMember'] },
    async () => {
        try {
            // Two kinds of household land here:
            //   1. Unclaimed-with-lead: a lead has an email to chase, but no lead has
            //      signed in with Google yet (a claimed lead covers the whole household,
            //      even if a student member never signs in).
            //   2. Broken: no household lead at all. These also show on
            //      /membership-ops/broken and must show here too — no email requirement,
            //      since a broken household may have no contactable member yet.
            // Mirrors the unclaimedHouseholds nav count in /api/nav/todo-counts —
            // shared predicate so the list and the badge can't drift.
            const households = await prisma.household.findMany({
                where: UNCLAIMED_OR_BROKEN_HOUSEHOLD_WHERE,
                include: { householdMembers: true }
            });

            const result = households.map(h => ({
                id: h.id,
                name: h.name
                    || h.householdMembers.find(p => p.name)?.name
                    || `Household #${h.id}`,
                members: h.householdMembers
                    .filter(p => p.email !== null)
                    .map(p => ({ id: p.id, name: p.name, email: p.email }))
            }));

            return NextResponse.json({ households: result });
        } catch (error) {
            logger.error("Failed to fetch unclaimed households:", error);
            return apiError("Failed to fetch unclaimed households", 500);
        }
    }
);
