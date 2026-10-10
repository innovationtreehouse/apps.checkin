import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { withAuth } from "@/lib/auth";
import { logBackendError, logger } from "@/lib/logger";
import { apiError } from "@/lib/api-response";
import { invalidateAttendanceCache } from "@/lib/getFullAttendance";
import { addHouseholdLead, HouseholdLeadLimitError, HouseholdLeadYouthError } from "@/lib/household/leads";

export const POST = withAuth<{ params: Promise<{ id: string }> }>(
    { roles: ['isSysadmin', 'isBoardMember'] },
    async (req: NextRequest, auth, { params }) => {
    try {
        const { id } = await params;
        if (auth.type !== 'session') {
            return apiError("Unauthorized", 401);
        }

        const participantId = parseInt(id);
        if (isNaN(participantId)) {
            logger.error(`Invalid participant ID from params: ${id}`);
            return apiError(`Invalid participant ID: ${id}`, 400);
        }

        const { householdId, createNew } = await req.json();

        if (!householdId && !createNew) {
            return apiError("Must provide either householdId or createNew boolean", 400);
        }

        const participant = await prisma.person.findUnique({ where: { id: participantId } });
        if (!participant) {
            return apiError("Participant not found", 404);
        }

        // Validate the destination before the write transaction below.
        const requestedHouseholdId = createNew ? null : parseInt(householdId);
        if (requestedHouseholdId !== null) {
            if (isNaN(requestedHouseholdId)) {
                return apiError("Invalid household ID", 400);
            }

            const household = await prisma.household.findUnique({ where: { id: requestedHouseholdId } });
            if (!household) {
                return apiError("Household not found", 404);
            }
        }

        // A person leads their OWN household, so a change of household
        // always clears the leadership flag, and
        // createNew then re-promotes them in the household created here. The
        // promotion goes through addHouseholdLead — the only writer of
        // isHouseholdLead: true — which owns the youth exclusion and the lead cap
        // under a Household row lock. It rejects a person whose householdId isn't
        // the target household, so the move must be written first; one
        // transaction keeps the whole reassign atomic and puts the helper's lock
        // in it. A same-household no-op leaves the flag untouched.
        const { updatedParticipant, targetHouseholdId } = await prisma.$transaction(async (tx) => {
            // New household starts as a visitor (no membership) — membership is
            // earned via the application process or set on the households page.
            const targetHouseholdId = requestedHouseholdId ?? (await tx.household.create({
                data: { name: `${participant.name || 'User'}'s Household` },
            })).id;

            const updated = await tx.person.update({
                where: { id: participantId },
                data: {
                    householdId: targetHouseholdId,
                    ...(participant.householdId !== targetHouseholdId ? { isHouseholdLead: false } : {}),
                },
                include: { household: true }
            });

            if (!createNew) return { updatedParticipant: updated, targetHouseholdId };

            // A rejected promotion aborts the whole reassign: the household just
            // created would have no possible lead, so it must not exist. The throw
            // rolls back the create and the move with it.
            const { created } = await addHouseholdLead(tx, targetHouseholdId, participantId);
            return {
                updatedParticipant: { ...updated, isHouseholdLead: updated.isHouseholdLead || created },
                targetHouseholdId,
            };
        });

        await prisma.auditLog.create({
            data: {
                actorId: auth.user.id,
                action: "EDIT",
                tableName: "Person",
                affectedEntityId: participantId,
                oldData: { householdId: participant.householdId },
                newData: { householdId: targetHouseholdId, createNew: Boolean(createNew) },
            },
        });

        invalidateAttendanceCache();

        return NextResponse.json({ success: true, participant: updatedParticipant });
    } catch (error) {
        if (error instanceof HouseholdLeadYouthError) {
            return apiError("A youth cannot lead a household, so they cannot be given one of their own. Assign them to an existing household instead.", 400);
        }
        if (error instanceof HouseholdLeadLimitError) {
            return apiError(error.message, 400);
        }
        await logBackendError(error, "POST /api/membership-ops/participants/[id]/household");
        return apiError(`Internal server error`, 500);
    }
});
