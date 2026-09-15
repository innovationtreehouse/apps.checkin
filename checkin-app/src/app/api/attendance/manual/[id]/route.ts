import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { handler, ApiResponseError, badRequest, notFound, unauthorized } from "@/security/handler";
import prisma from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { parseVisitTime, departureAfterArrival, withinMaxDuration } from "@/lib/visitTimes";
import { processVisitCheckout } from "@/lib/attendanceTransitions";
import { lastKeyholderGuard, runFacilityClose } from "@/lib/scan-service";
import type { CloseGuardResult } from "@/lib/scan-service";
import { editSignificance, deleteSignificance } from "@/lib/visit/significance";
import { visitSubject } from "@/lib/visit/scope";
import { emailBoardMembers } from "@/lib/emailRecipients";
import { escapeHtml } from "@/lib/email-templates/base";
import { logBackendError, logger } from "@/lib/logger";
import { formatDateTime } from "@/lib/time";
import { resolveDisplayTimezone } from "@/lib/appSettings";

// Side channel: handler() returns through stripBag, so the guard result
// can't ride the bag. A WeakMap keyed on the request lets the wrapper
// intercept a warning or run the facility close after the handler commits.
const guardResults = new WeakMap<Request, CloseGuardResult>();

// Self-correction of a member's own visits, and a household lead's correction
// of their household members' (trust-first, see
// docs/designs/1256_ATTENDANCE_CORRECTION_SURFACE.md §2/§3): the edit always
// applies — the only gates are validity (times parse, departure after arrival,
// ≤ 24h, no reopening) and scope. Integrity is post-hoc: every change is
// audited, and a significant one (big delta × trusted old source, doubled when
// an adult edits someone else's record, or any delete) is flagged to the board.
// Recurring-audit note: arbitrary backdate is accepted on purpose here exactly
// as on the sibling POST — self-reported hours are not a security boundary.

async function loadEditableVisit(id: number, actorId: number) {
    const visit = await prisma.visit.findUnique({ where: { id } });
    // Out-of-scope and tombstoned both read as 404 — no existence oracle on
    // other people's visit ids.
    if (!visit || visit.deletedAt) return null;
    if (!(await visitSubject(actorId, visit.personId))) return null;
    return visit;
}

function flagBoard(kind: "edit" | "delete", visitId: number, actorName: string, byProxy: boolean, score: number, detail: string) {
    // Fire-and-forget (errors logged and swallowed inside the helper): the
    // flag is oversight, never a gate on the member's response.
    // actorName is the member's self-editable profile name: escape it, it is
    // untrusted markup in the board's inbox.
    const whose = byProxy ? "a household member's" : "one of their own";
    void emailBoardMembers(
        `Attendance: significant ${byProxy ? "household" : "self"}-${kind} of visit #${visitId}`,
        `<p>${escapeHtml(actorName)} ${kind === "delete" ? "deleted" : "changed"} ${whose} visit ` +
        `(significance ${score}).</p><p>${detail}</p>` +
        `<p>Full before/after is in the audit trail (Visit #${visitId}).</p>`,
        "Self-correction board flag failed:",
    );
}

const _PATCH = handler<{ id: string }>('PATCH /api/attendance/manual/[id]', async ({ req, auth, params }) => {
    if (auth.type !== 'session') throw unauthorized();
    try {
        const userId = auth.user.id;
        const visitId = Number(params.id);
        if (!Number.isInteger(visitId)) throw badRequest("Invalid visit id");

        const body = await req.json().catch(() => null);
        if (!body || typeof body !== "object") throw badRequest("Invalid JSON");
        const { arrivedAt, departedAt } = body;
        if (!arrivedAt && !departedAt) throw badRequest("Nothing to change.");

        const visit = await loadEditableVisit(visitId, userId);
        if (!visit) throw notFound("Visit not found.");
        const byProxy = visit.personId !== userId;

        const now = new Date();
        let nextArrived = visit.arrivedAt;
        let nextDeparted = visit.departedAt;

        if (arrivedAt) {
            const r = parseVisitTime(arrivedAt, "arrival", now);
            if (!r.ok) throw badRequest(r.error);
            nextArrived = r.value;
        }
        if (departedAt) {
            const r = parseVisitTime(departedAt, "departure", now);
            if (!r.ok) throw badRequest(r.error);
            nextDeparted = r.value;
        }

        // A closed visit stays closed (same rule as the staff route): editing
        // must never turn a historical record back into "in the building".
        if (visit.departedAt && !nextDeparted) {
            throw badRequest("Departure time is required to close this visit.");
        }
        if (nextDeparted && !departureAfterArrival(nextArrived, nextDeparted)) {
            throw badRequest("Departure time must be after arrival time");
        }
        if (nextDeparted && !withinMaxDuration(nextArrived, nextDeparted)) {
            throw badRequest("A visit cannot be longer than 24 hours.");
        }

        const significance = editSignificance(visit, { arrivedAt: nextArrived, departedAt: nextDeparted }, { byProxy });

        const closingOpenVisit = !visit.departedAt && !!nextDeparted;

        if (closingOpenVisit) {
            const person = await prisma.person.findUnique({
                where: { id: visit.personId },
                select: { isKeyholder: true },
            });
            if (person) {
                const guard = await lastKeyholderGuard(visitId, person, body.forceCloseToken ?? null);
                guardResults.set(req, guard);
                if (guard.action === 'warn') return {};
            }
        }

        // Same per-person advisory lock as every other visit write: an edit
        // must not race the kiosk, the sweep, or a concurrent submit. The lock
        // is keyed on the visit's PERSON, not the actor — that is the key the
        // one-open-visit invariant is per, so a lead's edit serializes against
        // the member's own kiosk scan. When the edit CLOSES an open visit, only
        // the arrival is written here — the departure goes through
        // processVisitCheckout below, outside this lock (as on the sibling
        // POST); it refuses already-closed or tombstoned visits, and it owns
        // the back-to-back event chunking.
        const updated = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(${Number(visit.personId)})`;
            // Scope and liveness re-asserted under the lock: a DELETE that
            // landed since the pre-check must not have its tombstone overwritten.
            const live = await tx.visit.findFirst({
                where: { id: visitId, personId: visit.personId, deletedAt: null },
                select: { id: true },
            });
            if (!live) return null;
            // A corrected time becomes a typed clock: an edited arrival stamps
            // arrivedVia TYPED, an edited departure stamps departedVia TYPED.
            // Significance already read the pre-edit source above, so restamping
            // here only sets what the NEXT correction overwrites — a second
            // correction of the same time weighs it as a self-report, not a
            // measurement (docs/rules/attendance-checkin.md, visit-record).
            return tx.visit.update({
                where: { id: visitId },
                data: {
                    ...(arrivedAt ? { arrivedAt: nextArrived, arrivedVia: "TYPED" } : {}),
                    ...(departedAt && !closingOpenVisit ? { departedAt: nextDeparted, departedVia: "TYPED" } : {}),
                },
            });
        });
        if (!updated) throw notFound("Visit not found.");

        // The checkout chunks a program-enrolled stay into per-event rows,
        // replacing the original: the audit row and the response must name a row
        // that survives. Empty means the close lost a race — nothing applied.
        let surviving = updated;
        if (closingOpenVisit) {
            const chunks = await processVisitCheckout(visitId, nextDeparted!, undefined, "TYPED");
            if (chunks.length === 0) throw notFound("Visit not found.");
            surviving = chunks[chunks.length - 1];
        }

        await prisma.auditLog.create({
            data: {
                actorId: userId,
                action: "EDIT",
                tableName: "Visit",
                affectedEntityId: surviving.id,
                secondaryAffectedEntity: visit.personId,
                oldData: { id: visit.id, arrivedAt: visit.arrivedAt, departedAt: visit.departedAt, arrivedVia: visit.arrivedVia, departedVia: visit.departedVia },
                newData: { arrivedAt: nextArrived, departedAt: nextDeparted, type: "self_correction", significance },
            }
        });

        if (significance.flagged) {
            // Server-side: no TimezoneProvider here, so the configured zone is passed in.
            const timeZone = await resolveDisplayTimezone();
            flagBoard("edit", surviving.id, auth.user.name ?? `person #${userId}`, byProxy, significance.score,
                `${formatDateTime(visit.arrivedAt, { timeZone })} → ${formatDateTime(nextArrived, { timeZone })}`);
        }

        // The bag, not a hand-built body: stripBag keeps arrivedAt/departedAt for
        // the two subjects the registry grants (their_own / led_households) and
        // drops the 'internal' tombstone columns the raw row carries.
        return { Visit: surviving };
    } catch (error: unknown) {
        // handler() maps ApiResponseError to its declared status; anything else
        // is a real fault, and keeps the DB error log withAuth used to give it.
        if (!(error instanceof ApiResponseError)) await logBackendError(error, "PATCH /api/attendance/manual/[id]");
        throw error;
    }
});

const _DELETE = handler<{ id: string }>('DELETE /api/attendance/manual/[id]', async ({ req, auth, params }) => {
    if (auth.type !== 'session') throw unauthorized();
    try {
        const userId = auth.user.id;
        const visitId = Number(params.id);
        if (!Number.isInteger(visitId)) throw badRequest("Invalid visit id");

        const body = await req.json().catch(() => null);

        const visit = await loadEditableVisit(visitId, userId);
        if (!visit) throw notFound("Visit not found.");
        const byProxy = visit.personId !== userId;

        if (!visit.departedAt) {
            const person = await prisma.person.findUnique({
                where: { id: visit.personId },
                select: { isKeyholder: true },
            });
            if (person) {
                const guard = await lastKeyholderGuard(visitId, person, body?.forceCloseToken ?? null);
                guardResults.set(req, guard);
                if (guard.action === 'warn') return {};
            }
        }

        const significance = deleteSignificance(visit, { byProxy });

        // Tombstone, never a row removal: the deletion is reviewable in AT12
        // and reversible by clearing deletedAt. Same advisory lock as above, and
        // scope/liveness re-asserted inside it so a racing second delete is
        // a 404 rather than a re-stamped deletedAt.
        const tombstoned = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(${Number(visit.personId)})`;
            return tx.visit.updateMany({
                where: { id: visitId, personId: visit.personId, deletedAt: null },
                data: { deletedAt: new Date(), deletedById: userId },
            });
        });
        if (tombstoned.count === 0) throw notFound("Visit not found.");

        await prisma.auditLog.create({
            data: {
                actorId: userId,
                action: "DELETE",
                tableName: "Visit",
                affectedEntityId: visitId,
                secondaryAffectedEntity: visit.personId,
                oldData: { arrivedAt: visit.arrivedAt, departedAt: visit.departedAt, arrivedVia: visit.arrivedVia, departedVia: visit.departedVia },
                newData: { type: "self_correction", significance },
            }
        });

        // Every delete flags — the floor (§2).
        const timeZone = await resolveDisplayTimezone();
        flagBoard("delete", visitId, auth.user.name ?? `person #${userId}`, byProxy, significance.score,
            `Visit ${formatDateTime(visit.arrivedAt, { timeZone })} – ${visit.departedAt ? formatDateTime(visit.departedAt, { timeZone }) : "(open)"} tombstoned.`);

        // Empty bag — a tombstone ships no model data, so the registry declares
        // `envelope: null` and the 200 body is `{}` (stripBag drops any
        // non-model key, so the old { success, flagged } has no legal home).
        return {};
    } catch (error: unknown) {
        if (!(error instanceof ApiResponseError)) await logBackendError(error, "DELETE /api/attendance/manual/[id]");
        throw error;
    }
});

// Wrappers: intercept the close-guard side channel without changing
// handler.ts (boundary file — must ship alone per the isolation rule).
async function withCloseGuard(
    req: NextRequest,
    ctx: { params?: Promise<{ id: string }> } | undefined,
    inner: (req: NextRequest, ctx?: { params?: Promise<{ id: string }> }) => Promise<NextResponse>,
): Promise<NextResponse> {
    const result = await inner(req, ctx);
    const guard = guardResults.get(req);
    guardResults.delete(req);
    if (!guard) return result;

    if (guard.action === 'warn') {
        return NextResponse.json({
            error: guard.message,
            type: "warning",
            forceCloseToken: guard.token,
            confirmSeconds: guard.confirmSeconds,
        }, { status: 400 });
    }
    if (guard.facilityClosed && result.ok) {
        try { await runFacilityClose(); }
        catch (err) { logger.error("Facility close after manual correction failed:", err); }
    }
    return result;
}

const _guardedPATCH = (req: NextRequest, ctx?: { params?: Promise<{ id: string }> }) =>
    withCloseGuard(req, ctx, _PATCH);
const _guardedDELETE = (req: NextRequest, ctx?: { params?: Promise<{ id: string }> }) =>
    withCloseGuard(req, ctx, _DELETE);
export { _guardedPATCH as PATCH, _guardedDELETE as DELETE };
