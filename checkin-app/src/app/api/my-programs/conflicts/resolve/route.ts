import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { intervalsOverlap } from "@/lib/attendanceConflicts";
import { apiError } from "@/lib/api-response";
import { deleteSignificance } from "@/lib/visit/significance";
import { invalidateAttendanceCache } from "@/lib/getFullAttendance";

/**
 * Resolve an attendance conflict by deleting one of the duplicate Visit rows.
 * Real write, audited like every other Visit change (action DELETE, tableName
 * 'Visit', actorId, oldData snapshot) — see attendance/route.ts.
 *
 * Authorization is re-checked server-side (never trust the client): the caller
 * must lead the program that owns the event for the visit being deleted, or be a
 * global admin (isSysadmin/isBoardMember/isKeyholder) — mirroring the attendance route.
 * And the visit must actually be part of an overlap, so we can't be tricked into
 * deleting a participant's legitimate sole visit.
 *
 * ponytail: a plain lead can only delete a visit ANCHORED to their own event
 * (associatedEventId). In the kiosk-race case that's exactly the synthetic row to
 * drop (keep the real badge-in); the unassociated kiosk row is not directly
 * deletable here. Widen with an overlap-based scope check if leads need to delete
 * the kiosk side too.
 */
export const POST = withAuth({}, async (req, auth) => {
  if (auth.type !== "session") {
    return apiError("Unauthorized", 401);
  }
  const user = auth.user;

  const body = await req.json().catch(() => null);
  const visitId = body?.visitId;
  if (!Number.isInteger(visitId)) {
    return apiError("visitId (integer) is required", 400);
  }

  const visit = await prisma.visit.findUnique({
    where: { id: visitId },
    include: { event: { include: { program: { select: { leadMentorId: true } } } } },
  });
  if (!visit || visit.deletedAt) {
    return apiError("Visit not found", 404);
  }

  const isGlobalAdmin = !!(user.isSysadmin || user.isBoardMember || user.isKeyholder);
  const leadsOwningProgram = visit.event?.program?.leadMentorId === user.id;
  if (!isGlobalAdmin && !leadsOwningProgram) {
    return apiError("Forbidden: not authorized to resolve this visit", 403);
  }

  // Per-person advisory xact lock, as /api/scan and /api/facility/visits take:
  // the overlap guard and the tombstone must be one atomic step. Two leads
  // resolving opposite halves of the same overlap each see the other still live
  // otherwise, and both tombstone — erasing the session outright.
  const failure = await prisma.$transaction(async (tx): Promise<{ error: string; status: number } | null> => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${visit.personId})`;

    const current = await tx.visit.findUnique({ where: { id: visit.id } });
    if (!current || current.deletedAt) {
      return { error: "Visit not found", status: 404 };
    }

    // Only delete a visit that genuinely overlaps another of the same
    // participant's live visits. Refuse to delete an isolated, legitimate one.
    const siblings = await tx.visit.findMany({
      where: { personId: current.personId, id: { not: current.id }, deletedAt: null },
      select: { arrivedAt: true, departedAt: true },
    });
    if (!siblings.some((s) => intervalsOverlap(current, s))) {
      return { error: "Visit is not part of an attendance conflict", status: 409 };
    }

    // Tombstone, never a row removal — the same reversible delete every other
    // visit-write path takes (design §3). Resolving a conflict is a judgement
    // about which of two overlapping records is real; it must be possible to
    // back that judgement out.
    await tx.visit.update({
      where: { id: current.id },
      data: { deletedAt: new Date(), deletedById: user.id },
    });
    await tx.auditLog.create({
      data: {
        actorId: user.id,
        action: "DELETE",
        tableName: "Visit",
        affectedEntityId: current.id,
        // The subject, not the event — the event is in oldData below.
        secondaryAffectedEntity: current.personId,
        oldData: {
          personId: current.personId,
          arrivedAt: current.arrivedAt,
          departedAt: current.departedAt,
          arrivedVia: current.arrivedVia,
          departedVia: current.departedVia,
          associatedEventId: current.associatedEventId,
          reason: "duplicate-attendance-conflict",
        },
        // Scored off the same in-lock `current` snapshot as oldData above, not
        // the pre-lock row: a departure landing between the two reads is exactly
        // what the lock exists to order, and it changes the score.
        newData: { type: "conflict_resolution", significance: deleteSignificance(current, { byProxy: user.id !== current.personId }) },
      },
    });
    return null;
  }, { maxWait: 5000, timeout: 15000 });

  if (failure) return apiError(failure.error, failure.status);
  invalidateAttendanceCache();

  return NextResponse.json({ success: true, deletedVisitId: visit.id });
});
