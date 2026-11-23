import prisma from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { handler, ApiResponseError, badRequest, notFound, unauthorized } from "@/security/handler";
import { OPEN_VISIT_REFUSAL } from "@/lib/visitTimes";
import { invalidateAttendanceCache } from "@/lib/getFullAttendance";
import { findVisitOverlaps, openOverlapRefusal, overlapFlag } from "@/lib/visit/overlap";
import { lockLiveHouseholdsOf } from "@/lib/household/archiveGuard";
import { ServiceError } from "@checkin/component-kit";

// Clears a removed visit's tombstone so it counts again, and audits who
// restored it. Declared in the security registry (POST /api/facility/visits/restore).
export const POST = handler('POST /api/facility/visits/restore', async ({ req, auth }) => {
    if (auth.type !== 'session') throw unauthorized();

    const body = await req.json().catch(() => null);
    const visitId = body && typeof body === "object" ? Number(body.visitId) : NaN;
    if (!Number.isInteger(visitId) || visitId <= 0) throw badRequest("visitId is required.");

    const existing = await prisma.visit.findUnique({ where: { id: visitId }, select: { personId: true } });
    if (!existing) throw notFound("Removed visit not found.");

    // Same per-person advisory lock as every other visit write, with the
    // tombstone re-read inside it so a racing restore cannot audit twice.
    const result = await prisma.$transaction(async (tx: Prisma.TransactionClient): Promise<"missing" | "open" | { openSince: Date } | "restored"> => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${existing.personId})`;

        const current = await tx.visit.findUnique({ where: { id: visitId } });
        if (!current?.deletedAt) return "missing";
        // An open visit would put the person back in the building on staff say-so.
        if (!current.departedAt) return "open";
        await lockLiveHouseholdsOf(tx, [current.personId]);

        const overlaps = await findVisitOverlaps(tx, current.personId, { arrivedAt: current.arrivedAt, departedAt: current.departedAt }, visitId);
        if (overlaps.openSince) return { openSince: overlaps.openSince };

        const restored = await tx.visit.update({
            where: { id: visitId },
            data: { deletedAt: null, deletedById: null },
        });
        await tx.auditLog.create({
            data: {
                actorId: auth.user.id,
                action: "EDIT",
                tableName: "Visit",
                affectedEntityId: visitId,
                secondaryAffectedEntity: current.personId,
                oldData: JSON.parse(JSON.stringify(current)),
                newData: JSON.parse(JSON.stringify({ ...restored, type: "staff_restore", ...overlapFlag(overlaps.closedIds) })),
            },
        });
        return "restored";
    }, { maxWait: 5000, timeout: 15000 }).catch((e: unknown) => {
        if (e instanceof ServiceError) throw new ApiResponseError(e.status, e.message);
        throw e;
    });

    if (result === "missing") throw notFound("Removed visit not found.");
    if (result === "open") throw new ApiResponseError(409, OPEN_VISIT_REFUSAL);
    if (typeof result === "object") throw new ApiResponseError(409, await openOverlapRefusal(result.openSince));
    invalidateAttendanceCache();

    return {};
});
