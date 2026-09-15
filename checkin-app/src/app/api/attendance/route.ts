import { NextRequest, NextResponse } from "next/server";
import { withAuth, getOptionalSessionUser } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { getKioskPublicKeys, verifyKioskSignature } from "@/lib/verify-kiosk";
import { getFullAttendance } from "@/lib/getFullAttendance";
import { findAssociatedEventAt, processVisitCheckout } from "@/lib/attendanceTransitions";
import { lastKeyholderGuard, runFacilityClose } from "@/lib/scan-service";
import { lockFacility } from "@/lib/facilityLock";
import { sendCheckinNotifications } from "@/lib/notifications";
import { logBackendError, logger } from "@/lib/logger";
import { config } from "@/lib/config";
import { apiError } from "@/lib/api-response";
import { LIVE_PERSON } from "@/lib/person/filters";
import { LIVE_VISIT } from "@/lib/visit/filters";
import { systemActor } from "@/lib/auditActor";

// GET is kiosk-first with distinct signature-failure semantics (403 on bad signature,
// not 401), so it keeps its own kiosk plumbing rather than moving to withAuth. The one
// thing it was missing — the denied-household gate — is applied inline below.
export async function GET(req: NextRequest) {
    try {
        // Determine caller identity. getOptionalSessionUser applies the shared
        // denied-household gate (a denied member resolves to undefined), so even
        // on this kiosk-tolerant route a denied member can't read counts/safety.
        const user = await getOptionalSessionUser(req);

        // ops-stg ACCESS GATE (finding 2026-07-20): must run BEFORE the kiosk
        // branch below. This route re-verifies kiosk auth directly via
        // verifyKioskSignature rather than through authenticateRequest — the one
        // place that happens outside the chokepoint — so without this early
        // return, a caller carrying a VALID kiosk signature would still set
        // isKiosk=true, reach isAdmin, and get the full roster + safety data even
        // after the gate rejected them. See
        // tests/security/routeAuthDrift.test.ts rule 4.
        if (config.isStaging() && !user) {
            return apiError("Unauthorized", 401);
        }

        const hasKioskHeaders = req.headers.get("x-kiosk-signature");
        const pubKeys = getKioskPublicKeys();

        let isKiosk = false;

        // Minimization keys on the DISPLAY, not the credential (see
        // docs/rules/attendance-checkin.md, "The kiosk" — public-screen only).
        // A valid kiosk signature means this request is the public
        // kiosk screen — even when a keyholder has signed in on that same
        // browser. The staff grant (`keyholders:personal`) stays on a session
        // request that is NOT kiosk-signed (a laptop, not the door display).
        if (pubKeys.length > 0 && hasKioskHeaders) {
            const result = verifyKioskSignature(
                "GET",
                "/api/attendance",
                "",
                req.headers.get("x-kiosk-timestamp"),
                req.headers.get("x-kiosk-signature"),
                req.headers.get("x-kiosk-nonce"),
                pubKeys
            );
            if (!result.ok) {
                return apiError(result.error, result.status);
            }
            isKiosk = true;
        } else if (!user && pubKeys.length > 0) {
            // No session and no kiosk headers — reject
            return apiError("Unauthorized", 401);
        } else if (!user && pubKeys.length === 0 && config.isLocal()) {
            // Local dev only (CHECKIN_ENV=local): no pubKey configured, treat as kiosk.
            // Deliberately gated on isLocal() — on the cloud dev instance or prod an
            // unset KIOSK_PUBLIC_KEY must NOT grant full attendance/safety access to
            // anonymous callers. Mirrors the keyless-kiosk gating in src/lib/auth.ts.
            isKiosk = true;
        } else if (!user) {
            return apiError("Unauthorized", 401);
        }

        // The kiosk is an unattended device in a public room and re-broadcasts this
        // payload into an iframe with a wildcard postMessage target origin
        // (client/client.py). It gets a display-only roster: no dateOfBirth
        // (personal), no phone (pii), no emergency contacts (personal) — none of
        // which it renders. A signed-in keyholder on a non-kiosk browser still
        // gets the full payload (pickup/emergency lookups).
        const { attendance, counts, safety } = await getFullAttendance({ kiosk: isKiosk });

        // Determine access level
        const isAdmin = isKiosk || user?.isSysadmin || user?.isBoardMember || user?.isKeyholder;

        if (isAdmin) {
            // ⚠ corner count for the door display (§2 D7): parked scans awaiting
            // a human. An aggregate only — names and reasons stay on the panel.
            const needReview = await prisma.rawBadgeLog.count({
                where: { reviewReason: { not: null }, reviewedAt: null },
            });
            // Full roster access: all visits + counts (kiosk gets the reduced rows above)
            return NextResponse.json({
                access: "full",
                attendance,
                counts: { ...counts, needReview },
                safety,
                signedRequest: isKiosk,
            });
        }

        // Limited access: counts + household members + self only
        const selfVisit = user ? attendance.find(v => v.participant.id === Number(user.id)) || null : null;
        const householdVisits = (user?.householdId)
            ? attendance.filter(v => v.participant.householdId === user.householdId)
            : [];

        return NextResponse.json({
            access: "limited",
            counts,
            safety,
            self: selfVisit,
            household: householdVisits,
            signedRequest: isKiosk,
        });
    } catch (error) {
        await logBackendError(error, "GET /api/attendance");
        return apiError("Internal Server Error while fetching attendance.", 500);
    }
}

export const DELETE = withAuth({}, async (req, auth) => {
    if (auth.type !== 'session') return apiError("Unauthorized", 401);
    const user = auth.user;

    try {
        const body = await req.json();
        const { visitId, forceCloseToken: clientToken } = body;

        if (!visitId) {
            return apiError("visitId is required", 400);
        }

        const visit = await prisma.visit.findUnique({
            where: { id: visitId },
            include: { person: true }
        });

        if (!visit || visit.deletedAt) {
            return apiError("Visit not found", 404);
        }

        // Check permissions:
        // 1. User checking out themselves
        // 2. User is the household lead checking out a family member
        // 3. User is an admin (isSysadmin, isKeyholder, board member)
        const isSelf = visit.personId === Number(user.id);
        const isHouseholdCheckOut = Boolean(user.householdId && visit.person.householdId === user.householdId && user.householdLead);
        const isAdmin = user.isSysadmin || user.isKeyholder || user.isBoardMember;

        // Out of scope reads exactly as missing (same status, same message): a
        // caller not entitled to the visit learns nothing about whether the id
        // exists. docs/rules/principles.md — no existence oracle.
        if (!isSelf && !isHouseholdCheckOut && !isAdmin) {
            return apiError("Visit not found", 404);
        }

        if (visit.departedAt) {
            return apiError("Visit already checked out", 400);
        }

        // Last-keyholder close guard (shared with PATCH/DELETE manual/[id]).
        const guard = await lastKeyholderGuard(visitId, visit.person, clientToken);
        if (guard.action === 'warn') {
            return NextResponse.json({
                error: guard.message,
                type: "warning",
                forceCloseToken: guard.token,
                confirmSeconds: guard.confirmSeconds,
            }, { status: 400 });
        }
        const { facilityClosed } = guard;

        const finalVisits = await processVisitCheckout(visitId, new Date(), undefined, "TYPED");
        const updatedVisit = finalVisits.length > 0 ? finalVisits[finalVisits.length - 1] : visit;

        if (facilityClosed) {
            try {
                await runFacilityClose();
            } catch (err) {
                logger.error("Failed to close facility-wide visits after web checkout:", err);
            }
        }

        // Fire-and-forget: send check-out notifications (mirrors /api/scan)
        sendCheckinNotifications(visit.personId, 'checkout').catch(err =>
            logger.error('Checkout notification error:', err)
        );

        return NextResponse.json({ success: true, visit: updatedVisit, facilityClosed });
    } catch (error) {
        await logBackendError(error, "DELETE /api/attendance");
        return apiError("Failed to force checkout", 500);
    }
});

export const POST = withAuth({}, async (req, auth) => {
    if (auth.type !== 'session') return apiError("Unauthorized", 401);
    const user = auth.user;
    const isAdmin = user.isSysadmin || user.isKeyholder || user.isBoardMember;

    try {
        const body = await req.json();
        const { type, message, participantId } = body;

        // Manual Check-in explicitly via the Dashboard
        if (type === 'MANUAL_CHECKIN') {
            if (!participantId) {
                return apiError("participantId is required", 400);
            }

            // Verify participant exists. LIVE_PERSON: a merge tombstone must not be
            // checked into the building — it would create a Visit nobody can act on.
            const participant = await prisma.person.findFirst({
                where: { id: participantId, ...LIVE_PERSON }
            });

            if (!participant) {
                return apiError("Participant not found", 404);
            }

            // Check Permissions. Out of scope reads exactly as missing (same
            // status, same message), so an id the caller may not check in is
            // indistinguishable from one that does not exist — otherwise any
            // signed-in member could walk the person id space.
            // docs/rules/principles.md — no existence oracle.
            const isSelf = participant.id === Number(user.id);
            const isHouseholdCheckIn = Boolean(user.householdId && participant.householdId === user.householdId && user.householdLead);
            if (!isSelf && !isHouseholdCheckIn && !isAdmin) {
                return apiError("Participant not found", 404);
            }

            const arrivalTime = new Date();
            const eventId = await findAssociatedEventAt(participant.id, arrivalTime);

            // Read-then-create on this participant's open-visit state. Without
            // serialization, two concurrent MANUAL_CHECKINs — or one racing a kiosk
            // /api/scan or /api/attendance/manual — both pass the "already checked in?"
            // guard and create two open visits (a later checkout closes only one; the
            // other lingers open forever, inflating the two-deep supervision count).
            // Same per-participant advisory xact lock used by /api/scan and
            // /api/attendance/manual; the lock key is the participant id, so all three
            // paths serialize against each other. Re-check under the lock, then create.
            const result = await prisma.$transaction(async (tx) => {
                await tx.$executeRaw`SELECT pg_advisory_xact_lock(${participant.id})`;
                await lockFacility(tx);

                const activeVisit = await tx.visit.findFirst({
                    where: {
                        personId: participant.id,
                        departedAt: null,
                        ...LIVE_VISIT
                    }
                });

                if (activeVisit) {
                    return { alreadyCheckedIn: true as const };
                }

                // Same facility-open guard as /api/scan's processCheckin: a
                // non-keyholder cannot be the first in. Checked under the lock so a
                // racing keyholder check-in is either fully committed or not yet seen.
                if (!participant.isKeyholder) {
                    const activeKeyholders = await tx.visit.count({
                        where: { departedAt: null, person: { isKeyholder: true }, ...LIVE_VISIT }
                    });
                    if (activeKeyholders === 0) {
                        return { facilityClosed: true as const };
                    }
                }

                const visit = await tx.visit.create({
                    data: {
                        personId: participant.id,
                        arrivedAt: arrivalTime,
                        arrivedVia: "TYPED",
                        associatedEventId: eventId
                    }
                });

                return { alreadyCheckedIn: false as const, visit };
            }, {
                maxWait: 5000,
                timeout: 15000,
            });

            if ('facilityClosed' in result) {
                return apiError("Facility is closed. A Keyholder must check in first.", 403);
            }
            if (result.alreadyCheckedIn) {
                return apiError("User is already checked in", 400);
            }

            // Fire-and-forget: send check-in notifications (mirrors /api/scan)
            sendCheckinNotifications(participant.id, 'checkin').catch(err =>
                logger.error('Checkin notification error:', err)
            );

            return NextResponse.json({ success: true, visit: result.visit });
        }

        if (type === 'TWO_DEEP_VIOLATION') {
            // Debounce check: See if we already sent a notification recently (within 5 minutes)
            const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
            const recentLog = await prisma.auditLog.findFirst({
                where: {
                    tableName: 'SYSTEM_NOTIFY',
                    action: 'CREATE',
                    timestamp: { gte: fiveMinutesAgo }
                }
            });

            if (recentLog) {
                return NextResponse.json({ success: false, message: "Notification already sent recently." });
            }

            // Find all board members
            const boardMembers = await prisma.person.findMany({
                where: { isBoardMember: true, ...LIVE_PERSON },
                select: { email: true, name: true }
            });

            // Log that we sent the notification to prevent spam from multiple kiosks
            await prisma.auditLog.create({
                data: {
                    ...systemActor("kiosk:two-deep"),
                    action: 'CREATE',
                    tableName: 'SYSTEM_NOTIFY',
                    affectedEntityId: 0,
                    newData: { message: `Sent Two-Deep warning to ${boardMembers.length} board member(s).` } as unknown as never
                }
            });

            // In a real app, integrate Resend/SendGrid here using boardMembers.map(m => m.email)
            logger.info("CRITICAL NOTIFICATION TO BOARD MEMBERS:", boardMembers.map(m => m.email).join(', '));
            logger.info("Message:", message);

            return NextResponse.json({ success: true, notified: boardMembers.length });
        }

        return apiError("Unknown notification type", 400);
    } catch (error) {
        await logBackendError(error, "POST /api/attendance");
        return apiError("Failed to process notification", 500);
    }
});
