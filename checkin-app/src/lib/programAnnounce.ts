import { logger } from "@/lib/logger";
import prisma from "@/lib/prisma";
import { notifyNewProgramAnnounced } from "@/lib/notifications";
import { personActor, recordAudit } from "@/lib/auditActor";
import type { EnrollmentStatus, ProgramPhase } from "@/generated/prisma/client";

// Deliberately NOT in @/lib/notifications: the announce suites mock that module
// with a single-export factory, and a helper living there would come back
// undefined in every one of them.

type AnnounceState = {
    phase: ProgramPhase;
    enrollmentStatus: EnrollmentStatus;
};

type AnnouncedProgram = AnnounceState & {
    announceOnOpen: boolean;
    name: string;
    startAt: Date;
    endAt: Date;
    appliesToYear: number;
};

/**
 * Single gate for the "new program announced" email blast —
 * called by both program-edit PATCH routes after their update commits.
 *
 * Fires only on the transition INTO (UPCOMING && OPEN) with announceOnOpen on,
 * and at most ONCE per program lifetime: the announcedAt claim is a conditional
 * write, so concurrent PATCHes — or closing and reopening enrollment — can't
 * re-send the full-membership blast. announcedAt is never reset by design.
 *
 * Never throws: the program update has already committed when this runs, and a
 * failed announce must not turn that committed write into a 500.
 */
export async function maybeAnnounceOnOpen({ programId, before, after, actorId }: {
    programId: number;
    before: AnnounceState;
    after: AnnouncedProgram;
    actorId: number;
}): Promise<void> {
    try {
        const wasOpen = before.phase === 'UPCOMING' && before.enrollmentStatus === 'OPEN';
        const nowOpen = after.phase === 'UPCOMING' && after.enrollmentStatus === 'OPEN';
        if (wasOpen || !nowOpen) return;

        if (!after.announceOnOpen) {
            logger.info(`[announce] Program ${programId} reached UPCOMING+OPEN; announceOnOpen off — skipping.`);
            return;
        }

        // Once-per-lifetime claim. The conditional write wins races: two callers
        // that both read a stale "never announced" row land here, but only one
        // gets count === 1.
        // The routes' own audit rows record the field edit; this one records that
        // a full-membership email blast was triggered, by whom, when.
        const announcedAt = new Date();
        const claimed = await prisma.$transaction(async (tx) => {
            const claim = await tx.program.updateMany({
                where: { id: programId, announcedAt: null },
                data: { announcedAt },
            });
            if (claim.count !== 1) return false;
            await recordAudit(tx, personActor(actorId), {
                action: 'EDIT',
                tableName: 'Program',
                affectedEntityId: programId,
                newData: { event: 'PROGRAM_ANNOUNCE_BLAST', announcedAt: announcedAt.toISOString() },
            });
            return true;
        });
        if (!claimed) {
            logger.info(`[announce] Program ${programId} was already announced — skipping.`);
            return;
        }

        // Fire-without-await: paced send is ~(recipients/5) seconds — must not
        // block the PATCH response. notifyNewProgramAnnounced swallows its own
        // errors; .catch is belt-and-suspenders.
        void notifyNewProgramAnnounced(after).catch((e) =>
            logger.error("notifyNewProgramAnnounced failed:", e));
    } catch (error) {
        logger.error(`[announce] maybeAnnounceOnOpen failed for program ${programId}:`, error);
    }
}
