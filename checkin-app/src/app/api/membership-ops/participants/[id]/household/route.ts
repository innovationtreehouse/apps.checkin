import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { withAuth } from "@/lib/auth";
import { logBackendError, logger } from "@/lib/logger";
import { apiError } from "@/lib/api-response";
import { invalidateAttendanceCache } from "@/lib/getFullAttendance";
import { addHouseholdLead, HouseholdLeadLimitError, HouseholdLeadYouthError } from "@/lib/household/leads";
import { refuseSelfGrant } from "@/lib/membership/selfGrantGuard";
import { LIVE_PERSON } from "@/lib/person/filters";
import { lockBoardRoles } from "@/lib/roles";
import { lockAndFindDeniedHousehold, raiseDeniedHouseholdActivity } from "@/lib/membership/householdStatus";

/** The person was merged away between the pre-check and the write. */
class MergedPersonError extends Error {}
const MERGED_PERSON_MESSAGE = "This person has been merged into another record and cannot be moved.";

/** The person changed household between the pre-check and the write. */
class StaleSourceHouseholdError extends Error {}

/** The source or destination household is DENIED. */
class DeniedHouseholdMoveError extends Error {
    constructor(public readonly householdId: number, public readonly personId: number) {
        super(`household ${householdId} is denied`);
    }
}

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
        if (participant.mergedIntoId != null) {
            return apiError(MERGED_PERSON_MESSAGE, 409);
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

        // Moving someone out of or into the actor's own household would let a role be
        // granted around the own-household rule in lib/roles.ts, so neither end may be it.
        // Each refusal is audited, and an actor whose household can't be resolved is refused.
        const attempt = { table: "Person" as const, attempted: { householdId: requestedHouseholdId, createNew: Boolean(createNew) } };
        if (
            await refuseSelfGrant(prisma, auth.user.id, { personId: participantId, householdId: participant.householdId }, attempt)
            || (requestedHouseholdId !== null && await refuseSelfGrant(prisma, auth.user.id, { householdId: requestedHouseholdId }, attempt))
        ) {
            return apiError("You cannot move someone out of or into your own household — someone outside your household must.", 403);
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
            // Moving someone out of a DENIED household would free them of the denial, and
            // moving someone in would put them under it (a board member included, which a
            // deny refuses). The BOARD lock comes first, as a deny takes it, so a deny of
            // either household serializes with this move.
            await lockBoardRoles(tx);
            const denied = await lockAndFindDeniedHousehold(tx, requestedHouseholdId === null ? [participant.householdId] : [participant.householdId, requestedHouseholdId]);
            if (denied !== null) throw new DeniedHouseholdMoveError(denied, participantId);

            // New household starts as a visitor (no membership) — membership is
            // earned via the application process or set on the households page.
            const targetHouseholdId = requestedHouseholdId ?? (await tx.household.create({
                data: { name: `${participant.name || 'User'}'s Household` },
            })).id;

            // Conditional on the person still being live and still in the household locked
            // above, so a merge or another move that lands after the pre-check is refused.
            const { count } = await tx.person.updateMany({
                where: { id: participantId, householdId: participant.householdId, ...LIVE_PERSON },
                data: {
                    householdId: targetHouseholdId,
                    ...(participant.householdId !== targetHouseholdId ? { isHouseholdLead: false } : {}),
                },
            });
            if (count !== 1) {
                const now = await tx.person.findUnique({ where: { id: participantId }, select: { mergedIntoId: true } });
                throw now?.mergedIntoId != null ? new MergedPersonError() : new StaleSourceHouseholdError();
            }
            const updated = await tx.person.findUniqueOrThrow({ where: { id: participantId }, include: { household: true } });

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
        if (error instanceof MergedPersonError) {
            return apiError(MERGED_PERSON_MESSAGE, 409);
        }
        if (error instanceof StaleSourceHouseholdError) {
            return apiError("This person was moved to another household while you were working. Reload and try again.", 409);
        }
        if (error instanceof DeniedHouseholdMoveError) {
            await raiseDeniedHouseholdActivity({ householdId: error.householdId, personId: error.personId, what: "household reassign refused" });
            return apiError("This household has been denied membership, so no one can be moved into or out of it.", 409);
        }
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
