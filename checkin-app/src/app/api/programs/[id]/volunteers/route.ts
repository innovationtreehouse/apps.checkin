import { NextResponse } from "next/server";
import { orgToday } from "@/lib/appSettings";
import { logger } from "@/lib/logger";
import { withAuth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { isPrismaError } from "@/lib/prismaUniqueViolation";
import { apiError } from "@/lib/api-response";
import { isKnownAdult } from "@/lib/programAge";
import { refuseSelfGrant, SELF_GRANT_REFUSAL_MESSAGE } from "@/lib/membership/selfGrantGuard";
import { lockLiveHouseholdsOf } from "@/lib/household/archiveGuard";
import { isComponentHttpError, parseId, ServiceError } from "@checkin/component-kit";
import { personActor, recordAudit } from "@/lib/auditActor";
import { emailAfterAssignment, gatePositionCheck } from "@/lib/membership/positionCheck";
import { parseParticipantId, readObjectBody } from "@/app/api/programs/[id]/requestBody";
import { openPersonAgreementOnEngage } from "@/lib/membership/personAgreementTriggers";

/** A ServiceError's answer, keeping its code so the picker can ask for the check acknowledgement. */
function serviceErrorResponse(error: ServiceError) {
    return NextResponse.json({ error: error.message, ...(error.code ? { code: error.code } : {}) }, { status: error.status });
}

/**
 * A volunteer row confers volunteer standing and core grants scopes over enrolled
 * youth, so no actor may grant either to themselves or their own household.
 * Returns the error response to send, or null when the grant may proceed.
 */
async function refuseOwnHousehold(actorId: number, personId: number, programId: number, isCore: boolean) {
    const subject = await prisma.person.findFirst({ where: { id: personId }, select: { householdId: true } });
    if (!subject) return apiError("Participant not found", 400);
    const refused = await refuseSelfGrant(prisma, actorId, { personId, householdId: subject.householdId }, { table: "ProgramVolunteer", attempted: { programId, isCore } });
    return refused ? apiError(SELF_GRANT_REFUSAL_MESSAGE, 403) : null;
}

export const POST = withAuth({}, async (req, auth, { params }: { params: Promise<{ id: string }> }) => {
    if (auth.type !== 'session') return apiError("Unauthorized", 401);
    const { id } = await params;

    try {
        const programId = parseId(id, "program ID");

        const body = await readObjectBody(req);
        const participantId = parseParticipantId(body.participantId);
        const { acknowledgeCheck } = body;

        const currentProgram = await prisma.program.findUnique({ where: { id: programId } });
        if (!currentProgram) {
            return apiError("Program not found", 404);
        }

        const currentUserId = auth.user.id;
        const isLeadMentor = currentProgram.leadMentorId === currentUserId;
        const isSysAdminOrBoard = auth.user.isSysadmin || auth.user.isBoardMember;

        if (!isLeadMentor && !isSysAdminOrBoard) {
            return apiError("Forbidden: Not authorized to assign volunteers", 403);
        }

        const refused = await refuseOwnHousehold(currentUserId, participantId, programId, false);
        if (refused) return refused;

        // No eligibility gate (age/membership): a plain volunteer can be anyone.
        // Being made core (PATCH) is what requires a known adult.
        const { assignment, ackId } = await prisma.$transaction(async (tx) => {
            await lockLiveHouseholdsOf(tx, [participantId]);
            const created = await tx.programVolunteer.create({
                data: {
                    programId,
                    personId: participantId,
                    isCore: false
                }
            });
            await recordAudit(tx, personActor(currentUserId), {
                action: 'CREATE',
                tableName: 'ProgramVolunteer',
                affectedEntityId: participantId,
                secondaryAffectedEntity: programId,
                newData: created
            });
            const ackId = await gatePositionCheck(tx, { personId: participantId, position: 'PROGRAM_VOLUNTEER', programId, actorId: currentUserId, acknowledged: acknowledgeCheck === true });
            return { assignment: created, ackId };
        });
        await emailAfterAssignment(ackId === null ? [] : [ackId], currentUserId);
        await openPersonAgreementOnEngage(participantId);

        return NextResponse.json({ success: true, assignment });
    } catch (error) {
        if (isComponentHttpError(error)) {
            return apiError(error.message, error.status);
        }
        // P2002 = unique violation on @@id([programId, participantId]). Benign
        // double-submit re-assigns the same volunteer; 409 instead of 500.
        if (error instanceof ServiceError) {
            return serviceErrorResponse(error);
        }
        if (isPrismaError(error, 'P2002')) {
            return apiError("Participant is already a volunteer for this program.", 409);
        }
        // P2003 = FK violation: participantId points at no Participant row. Bad
        // input, not a server fault; 400 instead of 500.
        if (isPrismaError(error, 'P2003')) {
            return apiError("Participant not found", 400);
        }
        logger.error("Volunteer assignment error:", error);
        return apiError("Failed to assign volunteer", 500);
    }
});

export const DELETE = withAuth({}, async (req, auth, { params }: { params: Promise<{ id: string }> }) => {
    if (auth.type !== 'session') return apiError("Unauthorized", 401);
    const { id } = await params;

    try {
        const programId = parseId(id, "program ID");

        const body = await readObjectBody(req);
        const participantId = parseParticipantId(body.participantId);

        const currentProgram = await prisma.program.findUnique({ where: { id: programId } });
        if (!currentProgram) {
            return apiError("Program not found", 404);
        }

        const currentUserId = auth.user.id;
        const isLeadMentor = currentProgram.leadMentorId === currentUserId;
        const isSysAdminOrBoard = auth.user.isSysadmin || auth.user.isBoardMember;

        if (!isLeadMentor && !isSysAdminOrBoard) {
            return apiError("Forbidden: Not authorized to remove volunteers", 403);
        }

        const assignment = await prisma.$transaction(async (tx) => {
            const removed = await tx.programVolunteer.delete({
                where: {
                    programId_personId: {
                        programId,
                        personId: participantId
                    }
                }
            });
            await recordAudit(tx, personActor(currentUserId), {
                action: 'DELETE',
                tableName: 'ProgramVolunteer',
                affectedEntityId: participantId,
                secondaryAffectedEntity: programId,
                oldData: removed
            });
            return removed;
        });

        return NextResponse.json({ success: true, assignment });
    } catch (error) {
        if (isComponentHttpError(error)) {
            return apiError(error.message, error.status);
        }
        logger.error("Volunteer removal error:", error);
        return apiError("Failed to remove volunteer", 500);
    }
});

export const PATCH = withAuth({}, async (req, auth, { params }: { params: Promise<{ id: string }> }) => {
    if (auth.type !== 'session') return apiError("Unauthorized", 401);
    const { id } = await params;

    try {
        const programId = parseId(id, "program ID");

        const body = await readObjectBody(req);
        const { isCore, acknowledgeCheck } = body;

        if (!body.participantId || isCore === undefined) {
            return apiError("participantId and isCore are required", 400);
        }
        if (typeof body.participantId !== 'number' || typeof isCore !== 'boolean') {
            return apiError("participantId must be a number and isCore a boolean", 400);
        }
        const participantId = parseParticipantId(body.participantId);

        const currentProgram = await prisma.program.findUnique({ where: { id: programId } });
        if (!currentProgram) {
            return apiError("Program not found", 404);
        }

        const currentUserId = auth.user.id;
        const isLeadMentor = currentProgram.leadMentorId === currentUserId;
        const isSysAdminOrBoard = auth.user.isSysadmin || auth.user.isBoardMember;

        if (!isLeadMentor && !isSysAdminOrBoard) {
            return apiError("Forbidden: Not authorized to modify volunteers", 403);
        }

        // Clearing core stays open to anyone who may manage volunteers.
        if (isCore) {
            const refused = await refuseOwnHousehold(currentUserId, participantId, programId, true);
            if (refused) return refused;
            const person = await prisma.person.findUnique({
                where: { id: participantId },
                select: { dateOfBirth: true, isDeclaredAdult: true }
            });
            if (!person || !isKnownAdult(person, await orgToday())) {
                return apiError("A core volunteer must be an adult.", 400);
            }
        }

        const { assignment, ackId } = await prisma.$transaction(async (tx) => {
            if (isCore) await lockLiveHouseholdsOf(tx, [participantId]);
            const before = await tx.programVolunteer.findUnique({
                where: { programId_personId: { programId, personId: participantId } },
                select: { isCore: true }
            });
            const updated = await tx.programVolunteer.update({
                where: {
                    programId_personId: {
                        programId,
                        personId: participantId
                    }
                },
                data: {
                    isCore
                }
            });
            await recordAudit(tx, personActor(currentUserId), {
                action: 'EDIT',
                tableName: 'ProgramVolunteer',
                affectedEntityId: participantId,
                secondaryAffectedEntity: programId,
                newData: updated
            });
            const becameCore = isCore && before?.isCore === false;
            const ackId = becameCore
                ? await gatePositionCheck(tx, { personId: participantId, position: 'CORE_VOLUNTEER', programId, actorId: currentUserId, acknowledged: acknowledgeCheck === true })
                : null;
            return { assignment: updated, ackId };
        });
        await emailAfterAssignment(ackId === null ? [] : [ackId], currentUserId);

        return NextResponse.json({ success: true, assignment });
    } catch (error) {
        if (isComponentHttpError(error)) {
            return apiError(error.message, error.status);
        }
        if (error instanceof ServiceError) {
            return serviceErrorResponse(error);
        }
        logger.error("Volunteer toggle error:", error);
        return apiError("Failed to toggle volunteer", 500);
    }
});
