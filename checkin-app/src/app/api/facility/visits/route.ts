import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import prisma from "@/lib/prisma";
import type { Visit } from "@/generated/prisma/client";
import { withAuth } from "@/lib/auth";
import { apiError } from "@/lib/api-response";
import { parseVisitTime, departureAfterArrival, withinMaxDuration } from "@/lib/visitTimes";
import { editSignificance, deleteSignificance } from "@/lib/visit/significance";
import { handler } from "@/security/handler";

// Registry-governed (GET /api/facility/visits): admission anyRole
// sysadmin/board; envelope 'visits'. Nested person carries email (pii) —
// covered by the admin everyones band, and now stripped for any role a
// future view adds. Same query, same take-50 shape, same tombstone filter.
export const GET = handler('GET /api/facility/visits', async () => {
    const visits = await prisma.visit.findMany({
        take: 50,
        where: { deletedAt: null },
        orderBy: { arrivedAt: "desc" },
        include: {
            person: {
                select: { email: true, name: true, isSysadmin: true, isKeyholder: true },
            },
        },
    });

    return { Visit: visits };
});

export const PATCH = withAuth(
    { roles: ['isSysadmin', 'isBoardMember'] },
    async (req, auth) => {
        try {
            const { visitId, arrivedAt, departedAt } = await req.json();

            if (!visitId) {
                return apiError("visitId is required.", 400);
            }

            const existing = await prisma.visit.findUnique({ where: { id: visitId } });
            if (!existing || existing.deletedAt) {
                return apiError("Visit not found.", 404); // also turns a bad id into a clean 404
            }

            const now = new Date();
            let parsedArrived: Date | null = null;
            let parsedDeparted: Date | null = null;

            if (arrivedAt) {
                const r = parseVisitTime(arrivedAt, "arrival", now);
                if (!r.ok) return apiError(r.error, 400);
                parsedArrived = r.value;
            }
            if (departedAt) {
                const r = parseVisitTime(departedAt, "departure", now);
                if (!r.ok) return apiError(r.error, 400);
                parsedDeparted = r.value;
            }

            // Editing a visit is a read-modify-write on this person's visit state, so
            // it takes the same per-person advisory xact lock as /api/scan and re-reads
            // the row inside it — the pre-check above ran unserialized and a racing
            // scan or the facility-close sweep may have closed or removed the visit.
            const result = await prisma.$transaction(async (tx): Promise<{ error: string; status: number } | { visit: Visit; previous: Visit }> => {
                await tx.$executeRaw`SELECT pg_advisory_xact_lock(${existing.personId})`;

                const current = await tx.visit.findUnique({ where: { id: visitId } });
                if (!current || current.deletedAt) return { error: "Visit not found.", status: 404 as const };

                const nextArrived = parsedArrived ?? current.arrivedAt;
                const nextDeparted = parsedDeparted ?? current.departedAt;

                // Result must be closed: can close an open visit, never reopen a closed one.
                if (nextDeparted === null) {
                    return { error: "Departure time is required to close this visit.", status: 400 as const };
                }
                if (!departureAfterArrival(nextArrived, nextDeparted)) {
                    return { error: "Departure time must be after arrival time", status: 400 as const };
                }
                if (!withinMaxDuration(nextArrived, nextDeparted)) {
                    return { error: "A visit cannot be longer than 24 hours.", status: 400 as const };
                }

                return {
                    previous: current,
                    visit: await tx.visit.update({
                        where: { id: visitId },
                        data: {
                            // A corrected time becomes a typed clock: an edited
                            // arrival stamps arrivedVia TYPED, a departure staff typed
                            // stamps departedVia TYPED. Significance already read the
                            // pre-edit source (editSignificance below), so restamping
                            // only sets what the NEXT correction overwrites — a second
                            // correction weighs the value as a self-report.
                            ...(parsedArrived ? { arrivedAt: nextArrived, arrivedVia: "TYPED" } : {}),
                            ...(parsedDeparted ? { departedAt: nextDeparted, departedVia: "TYPED" } : {}),
                        },
                    })
                };
            }, { maxWait: 5000, timeout: 15000 });

            if ('error' in result) return apiError(result.error, result.status);
            const { visit: updatedVisit, previous } = result;

            // Log the manual edit in the audit trail. secondaryAffectedEntity =
            // the visit's person, so a correction review can tell self from
            // acting-for-another by comparison alone (design §6.6). oldData/
            // significance score against `previous` (the in-lock re-read), not
            // the pre-lock `existing` — a racing scan/close can change the row
            // between the two reads.
            if (auth.type === 'session') {
                await prisma.auditLog.create({
                    data: {
                        actorId: auth.user.id,
                        action: "EDIT",
                        tableName: "Visit",
                        affectedEntityId: visitId,
                        secondaryAffectedEntity: previous.personId,
                        oldData: JSON.parse(JSON.stringify(previous)),
                        newData: JSON.parse(JSON.stringify({
                            ...updatedVisit,
                            type: "staff_correction",
                            significance: editSignificance(previous, updatedVisit, { byProxy: auth.user.id !== previous.personId }),
                        })),
                    },
                });
            }

            return NextResponse.json({ visit: updatedVisit });
        } catch (error) {
            logger.error("Update visit error:", error);
            return apiError("Internal Server Error", 500);
        }
    }
);

export const DELETE = withAuth(
    { roles: ['isSysadmin', 'isBoardMember'] },
    async (req, auth) => {
        try {
            const { visitId } = await req.json();

            if (!visitId) {
                return apiError("visitId is required.", 400);
            }

            const existing = await prisma.visit.findUnique({ where: { id: visitId } });
            if (!existing || existing.deletedAt) {
                return apiError("Visit not found.", 404);
            }

            // Same per-person advisory xact lock as the PATCH above, with the
            // existence check re-run inside it so a racing delete can't tombstone
            // the row twice and overwrite who deleted it.
            const removed = await prisma.$transaction(async (tx) => {
                await tx.$executeRaw`SELECT pg_advisory_xact_lock(${existing.personId})`;

                const current = await tx.visit.findUnique({ where: { id: visitId } });
                if (!current || current.deletedAt) return null;

                // Tombstone, matching the member's own self-delete: a deleted visit
                // keeps its row so the deletion stays reviewable and reversible.
                await tx.visit.update({
                    where: { id: visitId },
                    data: { deletedAt: new Date(), deletedById: auth.type === 'session' ? auth.user.id : null },
                });
                return current;
            }, { maxWait: 5000, timeout: 15000 });

            if (!removed) return apiError("Visit not found.", 404);

            // Log the manual deletion in the audit trail — oldData carries the
            // pre-delete row so the review needs no join.
            if (auth.type === 'session') {
                await prisma.auditLog.create({
                    data: {
                        actorId: auth.user.id,
                        action: "DELETE",
                        tableName: "Visit",
                        affectedEntityId: visitId,
                        secondaryAffectedEntity: removed.personId,
                        oldData: JSON.parse(JSON.stringify(removed)),
                        newData: { type: "staff_removal", significance: deleteSignificance(removed, { byProxy: auth.user.id !== removed.personId }) },
                    },
                });
            }

            return NextResponse.json({ success: true });
        } catch (error) {
            logger.error("Delete visit error:", error);
            return apiError("Internal Server Error", 500);
        }
    }
);
