import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import prisma from "@/lib/prisma";
import { withAuth } from "@/lib/auth";
import type { TxClient } from "@/lib/db-client";
import { addHouseholdLead, removeHouseholdLead, HouseholdLeadLimitError, HouseholdLeadYouthError, HouseholdLeadDeniedError } from "@/lib/household/leads";
import { apiError } from "@/lib/api-response";
import { findSelfGrantRefusal, recordSelfGrantRefusal, type GrantAttempt, type SelfGrantRefusal } from "@/lib/membership/selfGrantGuard";
import { raiseDeniedHouseholdActivity } from "@/lib/membership/householdStatus";
import { ArchivedHouseholdError } from "@/lib/household/archiveGuard";
import { personActor, recordAudit } from "@/lib/auditActor";
import { settleAfterEvent } from "@/lib/membership/settleHouseholdBg";

/** The actor shares the target's household, found under its lock; recorded after the rollback. */
class SelfGrantLeadError extends Error {
    constructor(public readonly refusal: SelfGrantRefusal) {
        super("own household");
    }
}

const OWN_HOUSEHOLD_LEAD = "You cannot make yourself or someone in your own household a lead — someone outside your household must.";
const LEAD_ATTEMPT: GrantAttempt = { table: "Person", attempted: { isHouseholdLead: true } };

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
            const subject = { personId: participantId, householdId: targetHouseholdId };
            const selfGrant = isLeadOfTarget ? null : await findSelfGrantRefusal(prisma, userId, subject, LEAD_ATTEMPT);
            if (selfGrant) {
                await recordSelfGrantRefusal(prisma, selfGrant);
                return apiError(OWN_HOUSEHOLD_LEAD, 403);
            }

            // Re-read under the Household lock, so an actor who joined the household since the check above is refused.
            const recheckSelfGrant = isLeadOfTarget ? undefined : async (tx: TxClient) => {
                const lockedRefusal = await findSelfGrantRefusal(tx, userId, subject, LEAD_ATTEMPT);
                if (lockedRefusal) throw new SelfGrantLeadError(lockedRefusal);
            };

            const newLead = { householdId: targetHouseholdId, participantId };
            const created = await prisma.$transaction(async (tx) => {
                const { created } = await addHouseholdLead(tx, targetHouseholdId, participantId, recheckSelfGrant);
                if (created) {
                    await recordAudit(tx, personActor(userId), {
                        action: "CREATE",
                        tableName: "Person",
                        affectedEntityId: participantId,
                        secondaryAffectedEntity: targetHouseholdId,
                        newData: { ...newLead, isHouseholdLead: true },
                    });
                }
                return created;
            });

            if (!created) {
                return NextResponse.json({ message: "Member is already a lead" }, { status: 200 });
            }
            // A lead who already holds a current check can qualify the household's waiting application.
            await settleAfterEvent(targetHouseholdId, "lead promotion", {}, { personId: participantId });

            return NextResponse.json({ lead: newLead, message: "Member promoted to lead successfully." }, { status: 200 });

        } catch (error: unknown) {
            if (error instanceof SelfGrantLeadError) {
                await recordSelfGrantRefusal(prisma, error.refusal);
                return apiError(OWN_HOUSEHOLD_LEAD, 403);
            }
            if (error instanceof ArchivedHouseholdError) return apiError(error.message, error.status);
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
            const result = await prisma.$transaction(async (tx) => {
                const result = await removeHouseholdLead(tx, targetHouseholdId, participantId);
                if (result.removed) {
                    await recordAudit(tx, personActor(userId), {
                        action: "DELETE",
                        tableName: "Person",
                        affectedEntityId: participantId,
                        secondaryAffectedEntity: targetHouseholdId,
                        oldData: { householdId: targetHouseholdId, personId: participantId, isHouseholdLead: true },
                    });
                }
                return result;
            });
            if (!result.removed) {
                if (result.reason === "last_lead") {
                    return apiError("Cannot remove the last lead of a household.", 400);
                }
                return apiError("Member is not a lead", 400);
            }

            return NextResponse.json({ message: "Lead removed successfully." }, { status: 200 });

        } catch (error: unknown) {
            if (error instanceof ArchivedHouseholdError) return apiError(error.message, error.status);
            logger.error("Household Lead DELETE Error:", error);
            return apiError("Internal Server Error", 500);
        }
    }
);
