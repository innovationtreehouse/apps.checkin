import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import prisma from "@/lib/prisma";
import { withAuth } from "@/lib/auth";
import { addHouseholdLead, removeHouseholdLead, HouseholdLeadLimitError, HouseholdLeadYouthError, HouseholdLeadDeniedError } from "@/lib/household/leads";
import { apiError } from "@/lib/api-response";
import { refuseSelfGrant } from "@/lib/membership/selfGrantGuard";
import { raiseDeniedHouseholdActivity } from "@/lib/membership/householdStatus";

export const POST = withAuth(
    {},
    async (req, auth) => {
        try {
            if (auth.type !== 'session') return apiError("Unauthorized", 401);
            const userId = auth.user.id;

            const body = await req.json();
            const { participantId } = body;

            if (!participantId) {
                return apiError("Participant ID is required", 400);
            }

            const user = await prisma.person.findUnique({
                where: { id: userId },
                select: { isSysadmin: true, isBoardMember: true, isHouseholdLead: true, householdId: true }
            });

            const targetMember = await prisma.person.findUnique({ where: { id: participantId } });
            if (!targetMember) {
                return apiError("Participant not found", 404);
            }
            const targetHouseholdId = targetMember.householdId;

            // Board members and sysadmins can set a lead on ANY household (e.g. fixing
            // a leadless household imported without a primary contact). A regular
            // household lead can only promote within their own household.
            const isPrivileged = !!user?.isSysadmin || !!user?.isBoardMember;
            const isLeadOfTarget = !!user?.isHouseholdLead && user.householdId === targetHouseholdId;
            if (!isPrivileged && !isLeadOfTarget) {
                return apiError("Only household leads, board members, or sysadmins can promote members", 403);
            }

            // A lead promotes within their own household; the board and sysadmin path
            // into any other household may not reach the actor's own.
            if (!isLeadOfTarget && await refuseSelfGrant(prisma, userId, { personId: participantId, householdId: targetHouseholdId }, {
                table: "Person",
                attempted: { isHouseholdLead: true },
            })) {
                return apiError("You cannot make yourself or someone in your own household a lead — someone outside your household must.", 403);
            }

            const { created } = await addHouseholdLead(prisma, targetHouseholdId, participantId);

            if (!created) {
                return NextResponse.json({ message: "Member is already a lead" }, { status: 200 });
            }

            const newLead = { householdId: targetHouseholdId, participantId };
            await prisma.auditLog.create({
                data: {
                    actorId: userId,
                    action: "CREATE",
                    tableName: "Person",
                    affectedEntityId: participantId,
                    secondaryAffectedEntity: targetHouseholdId,
                    newData: { ...newLead, isHouseholdLead: true }
                }
            });

            return NextResponse.json({ lead: newLead, message: "Member promoted to lead successfully." }, { status: 200 });

        } catch (error: unknown) {
            if (error instanceof HouseholdLeadLimitError) {
                return apiError(error.message, 400);
            }
            if (error instanceof HouseholdLeadYouthError) {
                return apiError(error.message, 400);
            }
            if (error instanceof HouseholdLeadDeniedError) {
                await raiseDeniedHouseholdActivity({ householdId: error.householdId, personId: error.personId, what: "household lead promotion refused" });
                return apiError(error.message, 409);
            }
            logger.error("Household Lead POST Error:", error);
            return apiError("Internal Server Error", 500);
        }
    }
);

export const DELETE = withAuth(
    {},
    async (req, auth) => {
        try {
            if (auth.type !== 'session') return apiError("Unauthorized", 401);
            const userId = auth.user.id;

            const body = await req.json();
            const { participantId } = body;

            if (!participantId) {
                return apiError("Participant ID is required", 400);
            }

            const user = await prisma.person.findUnique({
                where: { id: userId },
                select: { isSysadmin: true, isBoardMember: true, isHouseholdLead: true, householdId: true }
            });

            const targetMember = await prisma.person.findUnique({
                where: { id: participantId },
                select: { householdId: true, isHouseholdLead: true }
            });
            if (!targetMember) {
                return apiError("Participant not found", 404);
            }
            const targetHouseholdId = targetMember.householdId;
            if (!targetHouseholdId) {
                return apiError("Member has no household", 400);
            }

            // Board members and sysadmins can remove a lead from ANY household — the
            // mirror of the promote path in POST. A regular household lead can only
            // remove leads within their own household.
            const isPrivileged = !!user?.isSysadmin || !!user?.isBoardMember;
            const isLeadOfTarget = !!user?.isHouseholdLead && user.householdId === targetHouseholdId;
            if (!isPrivileged && !isLeadOfTarget) {
                return apiError("Only household leads, board members, or sysadmins can remove leads", 403);
            }

            // Locked demote: refuses to drop the household's last lead, and
            // serializes concurrent demotes so two can't both pass the guard and
            // zero-lead the household (see removeHouseholdLead).
            const result = await removeHouseholdLead(prisma, targetHouseholdId, participantId);
            if (!result.removed) {
                if (result.reason === "last_lead") {
                    return apiError("Cannot remove the last lead of a household.", 400);
                }
                return apiError("Member is not a lead", 400);
            }

            await prisma.auditLog.create({
                data: {
                    actorId: userId,
                    action: "DELETE",
                    tableName: "Person",
                    affectedEntityId: participantId,
                    secondaryAffectedEntity: targetHouseholdId,
                    oldData: { householdId: targetHouseholdId, personId: participantId, isHouseholdLead: true }
                }
            });

            return NextResponse.json({ message: "Lead removed successfully." }, { status: 200 });

        } catch (error: unknown) {
            logger.error("Household Lead DELETE Error:", error);
            return apiError("Internal Server Error", 500);
        }
    }
);
