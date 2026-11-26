import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { withAuth } from "@/lib/auth";
import { logBackendError, logger } from "@/lib/logger";
import { apiError } from "@/lib/api-response";
import { invalidateAttendanceCache } from "@/lib/getFullAttendance";
import { addHouseholdLead, HouseholdLeadLimitError, HouseholdLeadMismatchError, HouseholdLeadYouthError, removeHouseholdLead } from "@/lib/household/leads";
import type { DbClient } from "@/lib/db-client";
import { findSelfGrantRefusal, recordSelfGrantRefusal, type SelfGrantRefusal } from "@/lib/membership/selfGrantGuard";
import { lockBoardRoles } from "@/lib/roles";
import { lockAndFindDeniedHousehold, raiseDeniedHouseholdActivity } from "@/lib/membership/householdStatus";
import { ArchivedHouseholdError, lockLiveHouseholds } from "@/lib/household/archiveGuard";
import { TreehouseHouseholdError, isTreehouseHousehold } from "@/lib/household/treehouseAccount";
import { personActor, recordAudit } from "@/lib/auditActor";

/** The person's row was deleted, by a merge or otherwise, between the pre-check and the write. */
class PersonGoneError extends Error {}

/** The person changed household between the pre-check and the write. */
class StaleSourceHouseholdError extends Error {}

/** The person is their household's only lead, and a household keeps one. */
class LastLeadMoveError extends Error {}

/** The source or destination household is DENIED. */
class DeniedHouseholdMoveError extends Error {
    constructor(public readonly householdId: number, public readonly personId: number) {
        super(`household ${householdId} is denied`);
    }
}

/** The actor shares either end's household, found under the Household locks; recorded after the rollback. */
class SelfGrantMoveError extends Error {
    constructor(public readonly refusal: SelfGrantRefusal) {
        super("own household");
    }
}

const OWN_HOUSEHOLD_MOVE = "You cannot move someone out of or into your own household — someone outside your household must.";

/**
 * Moving someone out of or into the actor's own household would let a role be granted
 * around the own-household rule in lib/roles.ts, so neither end may be it. An actor
 * whose household can't be resolved is refused. Writes nothing.
 */
async function moveSelfGrantRefusal(
    db: DbClient,
    actorId: number,
    person: { id: number; householdId: number },
    to: { householdId: number | null; createNew: boolean },
): Promise<SelfGrantRefusal | null> {
    const attempt = { table: "Person" as const, attempted: { householdId: to.householdId, createNew: to.createNew } };
    return await findSelfGrantRefusal(db, actorId, { personId: person.id, householdId: person.householdId }, attempt)
        ?? (to.householdId !== null ? await findSelfGrantRefusal(db, actorId, { householdId: to.householdId }, attempt) : null);
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

        const to = { householdId: requestedHouseholdId, createNew: Boolean(createNew) };
        const selfGrant = await moveSelfGrantRefusal(prisma, auth.user.id, participant, to);
        if (selfGrant) {
            await recordSelfGrantRefusal(prisma, selfGrant);
            return apiError(OWN_HOUSEHOLD_MOVE, 403);
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
        const { updatedParticipant } = await prisma.$transaction(async (tx) => {
            // Moving someone out of a DENIED household would free them of the denial, and
            // moving someone in would put them under it (a board member included, which a
            // deny refuses). The BOARD lock comes first, as a deny takes it, so a deny of
            // either household serializes with this move.
            await lockBoardRoles(tx);
            const denied = await lockAndFindDeniedHousehold(tx, requestedHouseholdId === null ? [participant.householdId] : [participant.householdId, requestedHouseholdId]);
            if (denied !== null) throw new DeniedHouseholdMoveError(denied, participantId);
            // Nobody moves into or out of an archived household.
            await lockLiveHouseholds(tx, requestedHouseholdId === null ? [participant.householdId] : [participant.householdId, requestedHouseholdId]);
            if (requestedHouseholdId !== null && requestedHouseholdId !== participant.householdId
                && await isTreehouseHousehold(tx, requestedHouseholdId)) {
                throw new TreehouseHouseholdError();
            }
            // Re-read under the Household locks, so an actor who joined either household since the check above is refused.
            const lockedRefusal = await moveSelfGrantRefusal(tx, auth.user.id, participant, to);
            if (lockedRefusal) throw new SelfGrantMoveError(lockedRefusal);

            // New household starts as a visitor (no membership) — membership is
            // earned via the application process or set on the households page.
            const targetHouseholdId = requestedHouseholdId ?? (await tx.household.create({
                data: { name: `${participant.name || 'User'}'s Household` },
            })).id;

            // The same locked demote the lead routes use, so a move never leaves the source household without a lead.
            let leadCleared = false;
            if (participant.householdId !== targetHouseholdId) {
                const demoted = await removeHouseholdLead(tx, participant.householdId, participantId);
                if (!demoted.removed && demoted.reason === "last_lead") throw new LastLeadMoveError();
                leadCleared = demoted.removed;
            }

            // Conditional on the person still being in the household locked above, so a
            // merge or another move that lands after the pre-check is refused.
            const { count } = await tx.person.updateMany({
                where: { id: participantId, householdId: participant.householdId },
                data: {
                    householdId: targetHouseholdId,
                    ...(participant.householdId !== targetHouseholdId ? { isHouseholdLead: false } : {}),
                },
            });
            if (count !== 1) {
                const now = await tx.person.findUnique({ where: { id: participantId }, select: { id: true } });
                throw now === null ? new PersonGoneError() : new StaleSourceHouseholdError();
            }
            const updated = await tx.person.findUniqueOrThrow({ where: { id: participantId }, include: { household: true } });
            await recordAudit(tx, personActor(auth.user.id), {
                action: "EDIT",
                tableName: "Person",
                affectedEntityId: participantId,
                oldData: { householdId: participant.householdId, ...(leadCleared ? { isHouseholdLead: true } : {}) },
                newData: { householdId: targetHouseholdId, ...(leadCleared ? { isHouseholdLead: false } : {}), createNew: Boolean(createNew) },
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

        invalidateAttendanceCache();

        return NextResponse.json({
            success: true,
            participant: updatedParticipant,
        });
    } catch (error) {
        if (error instanceof SelfGrantMoveError) {
            await recordSelfGrantRefusal(prisma, error.refusal);
            return apiError(OWN_HOUSEHOLD_MOVE, 403);
        }
        if (error instanceof PersonGoneError) {
            return apiError("This person's record no longer exists; they may have been merged into another. Reload and try again.", 404);
        }
        if (error instanceof LastLeadMoveError) {
            return apiError("This person is the household's only lead. Make someone else a lead first, then move them.", 409);
        }
        if (error instanceof StaleSourceHouseholdError || error instanceof HouseholdLeadMismatchError) {
            return apiError("This person was moved to another household while you were working. Reload and try again.", 409);
        }
        if (error instanceof ArchivedHouseholdError || error instanceof TreehouseHouseholdError) {
            return apiError(error.message, error.status);
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
