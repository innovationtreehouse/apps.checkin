import prisma from "@/lib/prisma";
import { findAssociatedEventAt, processVisitCheckout } from "@/lib/attendanceTransitions";
import { sendCheckinNotifications } from "@/lib/notifications";
import { apiError, apiJson } from "@/lib/api-response";
import type { FacilityCloseVia, Person } from "@/generated/prisma/client";
import { type DbClient, isRootClient } from "@/lib/db-client";
import { withFacilityLock } from "@/lib/facilityLock";
import { LIVE_VISIT } from "@/lib/visit/filters";
import { MAX_VISIT_MS } from "@/lib/visitTimes";
import { MIN_SUPERVISING_ADULTS, supervisingAdultCount, supervisingAdultVisits, youthIsPresent } from "@/lib/supervision";
import { isYouth } from "@/lib/time";
import { getKioskDisplayName, getKioskDisplayNames } from "@/lib/kiosk-names";
import { invalidateAttendanceCache } from "@/lib/getFullAttendance";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { logBackendError } from "@/lib/logger";
import { type AuditActor, personActor } from "@/lib/auditActor";
import { LIVE_PERSON } from "@/lib/person/filters";
import type { AuthenticatedUser } from "@/types/auth";
import { sendEmail } from "@/lib/email";
import { escapeHtml } from "@/lib/email-templates/base";
import { formatDateTime } from "@/lib/time";
import { resolveDisplayTimezone } from "@/lib/appSettings";

/**
 * What a scan response may say about who scanned: an id and the same
 * nickname-else-first-name label the kiosk roster shows. The kiosk renders this on
 * an unattended public screen and forwards it into an iframe with a wildcard
 * postMessage origin (client/client.py), so the raw Person — email, phone, date of
 * birth — never ships (docs/rules/attendance-checkin.md, "The kiosk").
 */
function scanParticipant(participant: Person) {
    return { id: participant.id, name: getKioskDisplayName(participant) };
}

/**
 * The "others are here" list on a force-close warning, labelled as the kiosk
 * roster labels people: nickname, else first name, a last initial only to tell
 * two apart, else the email local-part. Never a last name or an address — the
 * badge path renders it on the public kiosk screen (docs/rules/attendance-checkin.md,
 * "The kiosk"). Keyed by visit id, which is unique per row.
 */
function presentLabels(visits: { id: number; person: Pick<Person, "name" | "nickname" | "email"> }[]): string[] {
    const labels = getKioskDisplayNames(visits.map(v => ({ ...v.person, id: v.id })));
    return visits.flatMap(v => labels.get(v.id) || []);
}

/** Seconds the kiosk counts down after showing the force-close warning. The
 *  countdown is display; the confirm is the token, which has no elapsed-time
 *  gate — see the confirm check in processCheckout. */
export const FORCE_CLOSE_CONFIRM_SECONDS = 15;

/** Countdown on the supervision confirm (#1436). #1347 PR-0 extended the
 *  route's debounce exemption to a fresh `supervisionWarnedAt` stamp, so the
 *  full window is usable -- kiosk copy says "within 15 seconds". */
export const SUPERVISION_CONFIRM_MS = 15_000;

/** Floor on the route's debounce exemption (Fable review, #1347 PR-0): a USB
 *  hardware double-read of the warning scan lands ~300-800ms later with the
 *  stamp already fresh. Below this age, treat it as the same physical badge. */
export const SUPERVISION_CONFIRM_DEADFRONT_MS = 1_000;

/**
 * Process a check-in for a participant who has no active visit.
 *
 * The scan route passes its transaction client `db` so these reads and writes
 * run under the per-participant advisory lock. When called standalone (e.g.
 * unit tests) `db` defaults to the global prisma client. Notifications are the
 * caller's job, after commit (see notifyScanOutcome).
 */
export async function processCheckin(participant: Person, authType: string, db: DbClient = prisma, visitTime: Date = new Date()) {
    // Facility lock serializes the open-state read and the create against the
    // last-keyholder sweep: a check-in lands wholly before a close (and is swept)
    // or wholly after it. Same 2-arg lock space as runFacilityClose —
    // independent of the per-person lock the scan route already holds.
    return withFacilityLock(db, async (tx) => {
    // Callers read "no open visit" before this lock; a concurrent check-in for
    // the same person can land in that window. Park the scan instead of
    // letting the one-open-visit index throw.
    const openVisit = await tx.visit.findFirst({
        where: { personId: participant.id, departedAt: null, ...LIVE_VISIT },
        select: { id: true },
    });
    if (openVisit) {
        return apiJson({ type: "parked", reason: "double_in", message: "Recorded for review." });
    }

    // A badge at the kiosk always checks in — someone scanning inside the
    // building got in somehow, and the screen must show them. With no keyholder
    // present the visit reads as "no keyholder" (derived in getFullAttendance).
    // Every other surface still needs a keyholder present to open the building.
    if (!participant.isKeyholder && authType !== "kiosk") {
        const activeKeyholders = await tx.visit.count({
            where: {
                departedAt: null,
                deletedAt: null,
                person: { isKeyholder: true }
            }
        });
        if (activeKeyholders === 0) {
            return apiError("Facility is closed. A Keyholder must check in first.", 403);
        }
    }

    const arrivalTime = visitTime;
    const eventId = await findAssociatedEventAt(participant.id, arrivalTime, tx);

    const newVisit = await tx.visit.create({
        data: {
            personId: participant.id,
            arrivedAt: arrivalTime,
            arrivedVia: "SCANNER",
            associatedEventId: eventId
        },
    });
    invalidateAttendanceCache();

    // A youth arriving into a room short of supervision is WARNED, never blocked
    // (#1436): opening the door before the second adult is the keyholder's call to
    // make, and the app's job is to tell the room. Only asked for youth, so an
    // ordinary adult check-in still costs no extra query.
    const isYouthArrival = !participant.isDeclaredAdult
        && isYouth(participant.dateOfBirth, { unknownIs: "youth" });
    const supervisionWarning = isYouthArrival
        && supervisingAdultCount(await supervisingAdultVisits(tx)) < MIN_SUPERVISING_ADULTS
        ? `Warning: fewer than ${MIN_SUPERVISING_ADULTS} supervising adults are in the building.`
        : undefined;

    return apiJson({
        message: "Checked in successfully",
        type: "checkin" as const,
        warning: supervisionWarning,
        participant: scanParticipant(participant),
        visit: newVisit,
        signedRequest: authType === "kiosk",
    });
    });
}

/**
 * Process a check-out for a participant who has an active visit.
 * Handles last-isKeyholder logic and facility closure.
 *
 * `db` is the scan route's transaction client (covered by the per-participant
 * advisory lock) or, when called standalone, the global prisma client.
 */
export async function processCheckout(
    participant: Person,
    activeVisitId: number,
    authType: string,
    db: DbClient = prisma,
    /** Force-close confirm token echoed by this scan, live or replayed. */
    confirmToken: string | null = null,
    visitTime: Date = new Date(),
    /** clientEventId of a REPLAYED event (drain-delivered), null for a live scan. */
    replayEventId: string | null = null,
    /** The kiosk confirmed this close locally while offline — the two-scan
     *  confirm ran on the kiosk, no server token was ever minted to echo.
     *  Honored only on a replay; a live scan stays server-authoritative. */
    forceCloseConfirmed: boolean = false,
    /** A session checkout's close, decided by {@link lastKeyholderGuard}. */
    webClose: boolean = false,
) {
    let facilityClosed = authType !== "kiosk" && webClose;
    let closeOfferToken: string | null = null;

    if (participant.isKeyholder && authType === "kiosk") {
        const remainingKeyholders = await db.visit.count({
            where: {
                departedAt: null,
                deletedAt: null,
                person: { isKeyholder: true },
                id: { not: activeVisitId },
                // A late replay closes the building as it was at the scan: a
                // keyholder who arrived after it reopened a different session.
                ...(replayEventId ? { arrivedAt: { lte: visitTime } } : {}),
            }
        });

        if (remainingKeyholders === 0) {
            const remainingUsers = await db.visit.findMany({
                where: {
                    departedAt: null,
                    deletedAt: null,
                    id: { not: activeVisitId }
                },
                include: { person: true }
            });

            if (remainingUsers.length > 0) {
                const ownVisit = await db.visit.findUnique({
                    where: { id: activeVisitId },
                    select: { forceCloseToken: true }
                });
                // The confirm is the token this scan echoes, not the gap between
                // badges and not the wall clock: the countdown runs on the kiosk,
                // so a confirm queued through an outage still closes on arrival.
                // The token is a bearer credential, so compare it timing-safely:
                // hash both sides to a fixed length first (same idiom as
                // cronAuth.ts) so timingSafeEqual can't throw on a length
                // mismatch and no length leaks.
                const stored = ownVisit?.forceCloseToken;
                const confirmForceClose =
                    confirmToken != null && stored != null && timingSafeEqual(
                        createHash("sha256").update(stored).digest(),
                        createHash("sha256").update(confirmToken).digest()
                    );

                // Offline close: while disconnected the kiosk has no server token
                // to mint, so it runs the two-scan warning+confirm locally and
                // flags the confirmed close on the queued event. A force-close
                // confirm is valid by issuance (docs/rules/attendance-checkin.md,
                // kiosk resilience), extended here to a client-issued confirm -- a
                // keyholder standing at the reader confirmed the room is clear.
                // Honored only on a replay (the drain); a live scan carrying the
                // flag falls through to the server-authoritative token flow below.
                // This bypasses ONLY the token: a client flag closes only on a
                // keyholder's own scan.
                const offlineConfirmed = forceCloseConfirmed && replayEventId != null;

                if (!confirmForceClose && !offlineConfirmed && replayEventId) {
                    // A replay WITHOUT a token and WITHOUT the offline-confirmed flag
                    // was never confirmed by anyone, and nobody is at the reader hours
                    // later to answer a warning, so park it for a human. Never mint
                    // or stamp on a replay: an unattended countdown is not a confirm.
                    await db.rawBadgeLog.update({
                        where: { clientEventId: replayEventId },
                        data: { reviewReason: 'force_close_review' },
                    });
                    return apiJson({ type: 'parked', reason: 'force_close_review', message: 'Recorded for review.' });
                }

                if (!confirmForceClose && !offlineConfirmed) {
                    // Mint a fresh token with the warning; the old one dies here, so
                    // an unconfirmed countdown cannot be redeemed later.
                    const token = randomUUID();
                    await db.visit.update({
                        where: { id: activeVisitId },
                        data: { forceCloseWarnedAt: new Date(), forceCloseToken: token }
                    });

                    const names = presentLabels(remainingUsers).join(", ");
                    return apiJson({
                        error: `Warning! You are the last isKeyholder, but others are here:\n${names}\n\nBadge again within ${FORCE_CLOSE_CONFIRM_SECONDS} seconds to confirm you've checked them and close the facility.`,
                        type: "warning" as const,
                        forceCloseToken: token,
                        confirmSeconds: FORCE_CLOSE_CONFIRM_SECONDS
                    }, 400);
                }
            }

            facilityClosed = true;
        } else if (forceCloseConfirmed && replayEventId != null) {
            // The kiosk's offline two-scan close, from a keyholder whose visit is
            // still open while another keyholder is recorded: any keyholder may
            // close, so the other keyholder does not stop it.
            facilityClosed = true;
        } else if (authType === "kiosk" && !replayEventId) {
            // Another keyholder is still recorded inside, so this departure goes
            // through — but the keyholder may be the last one actually here, with
            // the other a forgotten badge-out. A second badge closes the building
            // (closeOnOfferConfirm). Never offered on a replay: nobody is at the
            // reader to badge again.
            closeOfferToken = randomUUID();
        }
    }

    if (facilityClosed) {
        // The token is spent. Clear it before the visit departs: a token on
        // a departed row is a live close offer (closeOnOfferConfirm).
        await db.visit.update({
            where: { id: activeVisitId },
            data: { forceCloseWarnedAt: null, forceCloseToken: null }
        });
        await sweepIfStandalone(db, { closedById: participant.id, via: closeVia(authType, replayEventId) }, visitTime);
    }

    // SUPERVISION INTERRUPT (#1436). Fires on EVERY badge departure, not just a
    // keyholder's — the close-guard above is a separate interrupt with its own
    // stamp. Skipped when the facility is closing: that sweep departs everyone.
    // Skipped for a REPLAY too: its 400 records nothing but the drain acks that
    // shape, so the queued departure would be dropped and the visit left open.
    // Hours-old bookkeeping has no room to warn about and nobody to re-badge.
    // Skipped for a web checkout as well: the badge scanner is the only place
    // anyone can re-badge (docs/rules/attendance-checkin.md, Supervision).
    let supervisionWarning: string | undefined;
    if (!facilityClosed && !replayEventId && authType === "kiosk") {
        const interrupt = await supervisionInterrupt(activeVisitId, db);
        if (interrupt?.confirmRequired) return interrupt.response;
        supervisionWarning = interrupt?.warning;
    }

    const finalVisits = await processVisitCheckout(activeVisitId, visitTime, db, "SCANNER");
    const updatedVisit = finalVisits.length > 0 ? finalVisits[finalVisits.length - 1] : null;
    // Stamped after the checkout: event-chunking may replace the original row.
    const closeOffer = closeOfferToken && updatedVisit
        ? await db.visit.update({
            where: { id: updatedVisit.id },
            data: { forceCloseWarnedAt: new Date(), forceCloseToken: closeOfferToken },
        }).then(() => ({
            closePrompt: `Others are still recorded inside. Badge again within ${FORCE_CLOSE_CONFIRM_SECONDS} seconds to close the building and check everyone out.`,
            forceCloseToken: closeOfferToken,
            confirmSeconds: FORCE_CLOSE_CONFIRM_SECONDS,
        }))
        : {};

    return apiJson({
        message: facilityClosed ? "Checked out and Facility closed" : "Checked out successfully",
        type: "checkout" as const,
        warning: supervisionWarning,
        participant: scanParticipant(participant),
        visit: updatedVisit,
        facilityClosed,
        ...closeOffer,
        signedRequest: authType === "kiosk",
    });
}

/**
 * The second badge of a keyholder whose checkout offered a close (see
 * processCheckout): they are already departed, so this closes the facility
 * without a visit of their own. Live, the scan must echo the offer's token; a
 * replay may instead carry the kiosk's offline two-scan confirm. Returns null
 * when the scan is not such a confirm.
 */
export async function closeOnOfferConfirm(
    participant: Person,
    authType: string,
    db: DbClient,
    confirmToken: string | null,
    replayEventId: string | null,
    forceCloseConfirmed: boolean,
    /** When the confirming badge was read; the sweep departs everyone at it. */
    closeTime: Date = new Date(),
): Promise<Response | null> {
    if (!participant.isKeyholder || authType !== "kiosk") return null;
    const offlineConfirmed = forceCloseConfirmed && replayEventId != null;
    if (!offlineConfirmed) {
        if (confirmToken == null) return null;
        const offered = await db.visit.findFirst({
            where: { personId: participant.id, departedAt: { not: null }, deletedAt: null, forceCloseToken: confirmToken },
            select: { id: true },
        });
        if (!offered) return null;
        await db.visit.update({
            where: { id: offered.id },
            data: { forceCloseWarnedAt: null, forceCloseToken: null },
        });
    }

    await sweepIfStandalone(db, { closedById: participant.id, via: closeVia(authType, replayEventId) }, closeTime);
    return apiJson({
        message: "Facility closed",
        type: "checkout" as const,
        participant: scanParticipant(participant),
        visit: null,
        facilityClosed: true,
        signedRequest: true,
    });
}

/**
 * The two-rung supervision ladder for a departure (#1436), keyed on how many
 * supervising adults would REMAIN — and only when this departure is what removes
 * one. A second adult from the same household leaving changes nothing, because
 * the household is still represented; that is the same-household rule.
 *
 *   remaining === 2 (the third supervising adult leaves) → warn, do not confirm.
 *   remaining  <  2 (the next one leaves), youth present → warn AND confirm.
 *   remaining  <  2 with no youth in the building        → warn, do not confirm.
 *
 * Only the confirm rung is youth-gated; the warn rung over-warns deliberately.
 *
 * The confirm is bound to the warning having been SHOWN, not to badge adjacency:
 * only a scan following a fresh `supervisionWarnedAt` stamp goes through, exactly
 * as the force-close confirm works. Countdown window is
 * {@link SUPERVISION_CONFIRM_MS}; #1347's explicit-confirm slice renders the tick.
 */
async function supervisionInterrupt(
    activeVisitId: number,
    db: DbClient,
): Promise<{ confirmRequired: true; response: Response } | { confirmRequired: false; warning?: string } | null> {
    const supervising = await supervisingAdultVisits(db);
    const before = supervisingAdultCount(supervising);
    const remaining = supervisingAdultCount(supervising, activeVisitId);
    if (remaining >= before || remaining > MIN_SUPERVISING_ADULTS) return null;

    if (remaining === MIN_SUPERVISING_ADULTS) {
        return {
            confirmRequired: false,
            warning: `Warning: only ${MIN_SUPERVISING_ADULTS} supervising adults remain in the building.`,
        };
    }

    const left = remaining === 1 ? "only 1 supervising adult" : "NO supervising adult";

    // The confirm rung is youth-gated (#1436, 2026-08-19): policy's floor is two
    // adults whenever a youth is, so an adult-only room locking up warns and goes.
    // Probed on this rung only — every quieter departure pays nothing for it.
    if (!(await youthIsPresent(db))) {
        return { confirmRequired: false, warning: `Warning: checking out leaves ${left} in the building.` };
    }

    const ownVisit = await db.visit.findUnique({
        where: { id: activeVisitId },
        select: { supervisionWarnedAt: true },
    });
    const warnedAt = ownVisit?.supervisionWarnedAt;
    if (warnedAt != null && Date.now() - warnedAt.getTime() <= SUPERVISION_CONFIRM_MS) {
        return { confirmRequired: false };
    }

    await db.visit.update({
        where: { id: activeVisitId },
        data: { supervisionWarnedAt: new Date() },
    });
    return {
        confirmRequired: true,
        response: apiJson({
            error: `Warning! Checking out leaves ${left} in the building.\n\nBadge again within ${SUPERVISION_CONFIRM_MS / 1000} seconds to confirm.`,
            type: "warning" as const,
        }, 400),
    };
}

/**
 * The facility-wide sweep takes row locks on EVERY open visit, and the email
 * kick fires its own DB queries. Neither may run inside the scan route's
 * per-participant advisory-lock transaction: it would block concurrent scans
 * for other participants and let the email run contend on the still-open
 * transaction. When called standalone (root client — e.g. tests) we own the
 * whole operation, so run them here; under the route's tx client the route runs
 * both AFTER it commits (see finalizeFacilityClose in route.ts).
 */
async function sweepIfStandalone(db: DbClient, closer: FacilityCloser, closeTime: Date) {
    if (!isRootClient(db)) return;
    await withFacilityLock(db, (tx) => closeAllOpenVisits(tx, closer, closeTime));
    invalidateAttendanceCache();
    kickPostEventEmails();
}

/** Depart everyone who was in the building at `closeTime` — the moment the last
 *  keyholder left. Live that is server now; a confirmed close replayed late
 *  carries the keyholder's own scan time (the route parks one from a clock
 *  running ahead; the clamp to now only absorbs the tolerated skew).
 *  Facility-wide, not participant-scoped: a single atomic statement, so it needs
 *  no wrapping transaction.
 *
 *  Raw rather than `updateMany` because the stamp is per-row: the close moment
 *  is capped at the visit's own `arrivedAt + MAX_VISIT_MS`, and `updateMany`
 *  can only set one constant for every row it touches.
 *
 *  Someone who arrived more than {@link LATE_CLOSE_SKEW_MS} after `closeTime`
 *  badged in after lock-up and is left as they are — a late close never ends a
 *  visit that began after it. An arrival inside the skew is the kiosk's clock
 *  disagreeing with the server's, so it departs too, no earlier than it
 *  arrived. A visit the nightly cron already AUTO_CLOSEd past `closeTime` is
 *  pulled back to it — the cron stamped only because the close had not arrived
 *  yet. Live, nobody arrived after `closeTime` and no departure lies in the
 *  future.
 *
 *  FACILITY_CLOSE, not AUTO_CLOSE: the stamp is the moment the building
 *  actually closed, so it is bounded by building hours — plausible, unlike the
 *  cron's midnight sweep. Where the cap bites the stamp is 24h after arrival
 *  instead; both are placeholders the member is meant to correct, and a
 *  placeholder inside the 24h rule beats an accurate record that breaks it.
 *
 *  The columns are timestamp-without-zone holding UTC, so the instant is
 *  converted AT TIME ZONE 'UTC' or the comparison is off by the server's offset. */
/** Kiosk-vs-server clock skew a late close absorbs on the arrival side. */
export const LATE_CLOSE_SKEW_MS = 2 * 60_000;

/** Who closed the facility, and through which path. */
export type FacilityCloser = { closedById: number; via: FacilityCloseVia };

/** The path a scan-route close came through. */
export function closeVia(authType: string, replayEventId: string | null): FacilityCloseVia {
    if (authType !== "kiosk") return "WEB_CHECKOUT";
    // A replay reached the server from the kiosk's offline queue, whichever confirm it carries.
    return replayEventId != null ? "KIOSK_OFFLINE" : "KIOSK";
}

export type DepartureChange = {
    id: number;
    /** The open visit this row replaced, when the checkout split it into segments. */
    previousVisitId?: number;
    personId: number;
    oldDepartedAt: Date | null;
    oldDepartedVia: string | null;
    departedAt: Date;
    departedVia: string;
};

/** Log each departure a facility close set, with its before and after, against
 *  the close record. */
export async function logCloseDepartures(
    db: DbClient,
    facilityCloseId: number,
    actor: AuditActor,
    changes: DepartureChange[],
): Promise<void> {
    if (changes.length === 0) return;
    await db.auditLog.createMany({
        data: changes.map(c => ({
            ...actor,
            action: "EDIT" as const,
            tableName: "FacilityClose",
            affectedEntityId: facilityCloseId,
            secondaryAffectedEntity: c.id,
            oldData: { visitId: c.previousVisitId ?? c.id, personId: c.personId, departedAt: c.oldDepartedAt, departedVia: c.oldDepartedVia },
            newData: { visitId: c.id, personId: c.personId, departedAt: c.departedAt, departedVia: c.departedVia },
        })),
    });
}

async function closeAllOpenVisits(db: DbClient, closer: FacilityCloser, closeTime: Date = new Date()) {
    const closedAt = new Date(Math.min(closeTime.getTime(), Date.now()));
    const closeAt = closedAt.toISOString();
    const close = await db.facilityClose.create({
        data: { closedAt, closedById: closer.closedById, via: closer.via },
        select: { id: true },
    });
    // Tombstoned visits are excluded: closing one would rewrite a record the
    // member chose to erase, and resurrect a machine departure if it is undone.
    // `old` locks each row before reading it, so the logged before-value is the
    // one this statement overwrites.
    const changes = await db.$queryRaw<DepartureChange[]>`
        WITH t AS (
            SELECT (${closeAt}::timestamptz AT TIME ZONE 'UTC') AS close_at
        ), old AS (
            SELECT v.id, v."departedAt", v."departedVia"
            FROM "Visit" v, t
            WHERE v."deletedAt" IS NULL
              AND v."arrivedAt" <= t.close_at + ${LATE_CLOSE_SKEW_MS}::double precision * interval '1 millisecond'
              AND (v."departedAt" IS NULL
                   OR (v."departedVia" = 'AUTO_CLOSE'::"VisitSource" AND v."departedAt" > t.close_at))
            FOR UPDATE OF v
        )
        UPDATE "Visit" v
        SET "departedAt" = LEAST(
                GREATEST(t.close_at, v."arrivedAt"),
                v."arrivedAt" + ${MAX_VISIT_MS}::double precision * interval '1 millisecond'
            ),
            "departedVia" = 'FACILITY_CLOSE'::"VisitSource",
            "facilityCloseId" = ${close.id}
        FROM t, old
        WHERE v.id = old.id
        RETURNING v.id, v."personId", old."departedAt" AS "oldDepartedAt", old."departedVia"::text AS "oldDepartedVia",
                  v."departedAt", v."departedVia"::text AS "departedVia"`;
    await logCloseDepartures(db, close.id, personActor(closer.closedById), changes);
}

/** Fire-and-forget post-event email run on facility close. The dynamic import
 *  AND the call are both in the promise chain, so an import or run failure is
 *  logged, never an unhandled rejection. */
function kickPostEventEmails() {
    import("@/lib/postEventEmails")
        .then(({ processPostEventEmails }) => processPostEventEmails({ forceImmediate: true }))
        .catch(err => console.error("Failed to run post-event emails on facility close:", err));
}

/**
 * Close every open visit and kick post-event emails. Called after the
 * last-keyholder checkout is committed — both from the scan route (via
 * finalizeFacilityClose) and from web close paths.
 */
export async function runFacilityClose(closer: FacilityCloser, closeTime: Date = new Date()): Promise<void> {
    await withFacilityLock(prisma, (tx) => closeAllOpenVisits(tx, closer, closeTime));
    // After the lock/tx commits so a concurrent kiosk GET cannot refill the
    // cache from still-open rows (READ COMMITTED).
    invalidateAttendanceCache();
    kickPostEventEmails();
}

/** Timing-safe force-close token compare: hash both sides to a fixed length so
 *  timingSafeEqual can't throw on a length mismatch and no length leaks. */
export function forceCloseTokenMatches(stored: string | null | undefined, given: string | null | undefined): boolean {
    return stored != null && given != null && timingSafeEqual(
        createHash("sha256").update(stored).digest(),
        createHash("sha256").update(given).digest()
    );
}

/** A web caller's answer to the last-keyholder choice; cancel sends nothing. */
export type CloseChoice = "close" | "leave";

/** The signed-in person checking a keyholder out, correcting or removing their visit. */
export type CloseActor = { id: number; isKeyholder: boolean; isBoardMember: boolean; isSysadmin: boolean };

/** What the caller echoes back from the choice: the token, the choice, and for a leave the keyholder named. */
export type CloseConfirm = { token?: unknown; choice?: unknown; handoverToId?: unknown };

/** The 400 body a web path returns when the last keyholder leaves others inside. */
export type CloseChoiceWarning = {
    error: string;
    type: "close_choice";
    othersInside: number;
    choices: (CloseChoice | "cancel")[];
    forceCloseToken: string;
    confirmSeconds: number;
    /** Kiosk labels of everyone else inside; only to callers who read the roster. */
    names?: string[];
    /** Keyholders with no open visit, for a leave to name; only to callers who may close. */
    keyholders?: { id: number; name: string }[];
};

/** A choice a caller made, for the audit row and the handover email. */
export type CloseChoiceMade = { choice: CloseChoice; handoverToId: number | null; othersInside: number };

export type CloseGuardResult =
    | { action: "proceed"; facilityClosed: boolean; choice: CloseChoiceMade | null }
    | { action: "warn"; warning: CloseChoiceWarning }
    | { action: "refuse"; error: string; status: 400 | 409 };

export function closeActor(user: AuthenticatedUser): CloseActor {
    return { id: Number(user.id), isKeyholder: !!user.isKeyholder, isBoardMember: !!user.isBoardMember, isSysadmin: !!user.isSysadmin };
}

/** The board, and a keyholder checking themselves out, may close the building;
 *  nobody else does (Arts. VI–VII). */
const mayClose = (actor: CloseActor, subjectId: number) => actor.isBoardMember || (actor.isKeyholder && actor.id === subjectId);

/** Keyholders, the board and sysadmins already read the full roster. */
const readsRoster = (actor: CloseActor) => actor.isKeyholder || actor.isBoardMember || actor.isSysadmin;

/** Live keyholders other than the leaver with no open visit: who a leave can name. */
async function handoverCandidates(db: DbClient, subjectId: number) {
    const people = await db.person.findMany({
        where: { ...LIVE_PERSON, isKeyholder: true, id: { not: subjectId }, visits: { none: { departedAt: null, deletedAt: null } } },
        select: { id: true, name: true, nickname: true, email: true },
    });
    const labels = getKioskDisplayNames(people);
    return people.map(p => ({ id: p.id, name: labels.get(p.id) ?? "" }));
}

/**
 * Last-keyholder guard for every web path that ends an open visit: checkout,
 * correction and removal. When the visit is the last keyholder's and others
 * are inside, the caller chooses close, leave or cancel:
 *
 * - a keyholder checking themselves out, or a board member, gets all three; a
 *   leave names the keyholder handed over to, unless no keyholder is free to name;
 * - anyone else — another keyholder, a household lead, a sysadmin — gets leave
 *   or cancel and names nobody;
 * - a removal never closes, whoever makes it.
 *
 * The token is bound to the actor shown the choice, and the allowed choices are
 * worked out again on confirm, so a role revoked in between takes effect.
 * A keyholder alone in the record closes with no warning when the caller may
 * close. Callers depart or remove the visit, then call {@link finishCloseGuard}.
 */
export async function lastKeyholderGuard(
    visitId: number,
    subject: { id: number; isKeyholder: boolean },
    actor: CloseActor,
    confirm: CloseConfirm,
    opts: { removal?: boolean } = {},
    db: DbClient = prisma,
): Promise<CloseGuardResult> {
    const proceed = { action: "proceed" as const, facilityClosed: false, choice: null };
    if (!subject.isKeyholder) return proceed;

    const remainingKeyholders = await db.visit.count({
        where: { departedAt: null, deletedAt: null, person: { isKeyholder: true }, id: { not: visitId } }
    });
    if (remainingKeyholders > 0) return proceed;

    const canClose = !opts.removal && mayClose(actor, subject.id);
    const othersInside = await db.visit.count({ where: { departedAt: null, deletedAt: null, id: { not: visitId } } });
    const clearToken = () => db.visit.update({
        where: { id: visitId },
        data: { forceCloseWarnedAt: null, forceCloseToken: null, forceCloseActorId: null },
    });

    if (othersInside === 0) {
        await clearToken();
        return { ...proceed, facilityClosed: canClose };
    }

    const choices: CloseChoice[] = canClose ? ["close", "leave"] : ["leave"];
    const visit = await db.visit.findUnique({
        where: { id: visitId },
        select: { forceCloseToken: true, forceCloseActorId: true },
    });
    const token = typeof confirm.token === "string" ? confirm.token : null;
    const confirmed = visit?.forceCloseActorId === actor.id && forceCloseTokenMatches(visit.forceCloseToken, token);

    // A token that does not answer this caller's open choice — spent, replaced,
    // or shown to someone else — is refused, never re-bound to this caller.
    if (token != null && !confirmed) {
        return { action: "refuse", error: "That choice has expired or was already answered.", status: 409 };
    }

    if (!confirmed) {
        const fresh = randomUUID();
        await db.visit.update({
            where: { id: visitId },
            data: { forceCloseWarnedAt: new Date(), forceCloseToken: fresh, forceCloseActorId: actor.id },
        });
        const others = othersInside === 1 ? "1 other person is" : `${othersInside} other people are`;
        const consequence = opts.removal
            ? "Removing this visit leaves them inside a closed facility."
            : canClose
                ? "Close the facility and check everyone out, or leave having handed over to another keyholder."
                : "Checking out leaves them inside a closed facility.";
        return {
            action: "warn",
            warning: {
                error: `No other keyholder is checked in. ${others} still recorded inside. ${consequence}`,
                type: "close_choice",
                othersInside,
                choices: [...choices, "cancel"],
                forceCloseToken: fresh,
                confirmSeconds: FORCE_CLOSE_CONFIRM_SECONDS,
                ...(readsRoster(actor) ? {
                    names: presentLabels(await db.visit.findMany({
                        where: { departedAt: null, deletedAt: null, id: { not: visitId } },
                        include: { person: true },
                    })),
                } : {}),
                ...(canClose ? { keyholders: await handoverCandidates(db, subject.id) } : {}),
            },
        };
    }

    const choice = choices.find(c => c === confirm.choice);
    if (!choice) return { action: "refuse", error: "That choice is not available.", status: 400 };

    let handoverToId: number | null = null;
    if (choice === "leave" && canClose) {
        const candidates = await handoverCandidates(db, subject.id);
        if (confirm.handoverToId == null) {
            // Nobody free to name: the leave stands, recorded as not named.
            if (candidates.length > 0) return { action: "refuse", error: "Name the keyholder you handed over to.", status: 400 };
        } else {
            const named = typeof confirm.handoverToId === "number" && Number.isInteger(confirm.handoverToId)
                ? await db.person.findFirst({
                    where: { ...LIVE_PERSON, id: confirm.handoverToId, isKeyholder: true, NOT: { id: subject.id } },
                    select: { id: true },
                })
                : null;
            if (!named) return { action: "refuse", error: "The keyholder named is not a current keyholder.", status: 400 };
            handoverToId = named.id;
        }
    }

    // Single use: only one confirm of this token consumes it, however many race.
    const consumed = await db.visit.updateMany({
        where: { id: visitId, deletedAt: null, forceCloseToken: visit.forceCloseToken, forceCloseActorId: actor.id },
        data: { forceCloseWarnedAt: null, forceCloseToken: null, forceCloseActorId: null },
    });
    if (consumed.count === 0) {
        return { action: "refuse", error: "That choice has expired or was already answered.", status: 409 };
    }
    return { action: "proceed", facilityClosed: choice === "close", choice: { choice, handoverToId, othersInside } };
}

/**
 * After the guarded visit is departed or removed: run the close the guard
 * decided on, audit the caller's choice, and email a named keyholder who is not
 * checked in. Never throws; the checkout has already committed.
 */
export async function finishCloseGuard(
    guard: Extract<CloseGuardResult, { action: "proceed" }>,
    ctx: { actorId: number; subjectId: number; visitId: number; via: FacilityCloseVia },
): Promise<void> {
    if (guard.facilityClosed) await closeWithRetry({ closedById: ctx.actorId, via: ctx.via });
    if (!guard.choice) return;
    const { choice, handoverToId, othersInside } = guard.choice;
    try {
        await prisma.auditLog.create({
            data: {
                ...personActor(ctx.actorId),
                action: "EDIT",
                tableName: "Visit",
                affectedEntityId: ctx.visitId,
                secondaryAffectedEntity: ctx.subjectId,
                newData: { type: "last_keyholder_choice", choice, via: ctx.via, handoverToId, othersInside },
            },
        });
        if (handoverToId != null) await emailHandover(handoverToId, ctx.subjectId, othersInside);
    } catch (err) {
        await logBackendError(err, "last-keyholder-choice");
    }
}

/** Tell the keyholder a leaver named that the building was left to them, unless they are checked in. */
async function emailHandover(handoverToId: number, leaverId: number, othersInside: number) {
    const [named, leaver, open] = await Promise.all([
        prisma.person.findUnique({ where: { id: handoverToId }, select: { email: true, name: true } }),
        prisma.person.findUnique({ where: { id: leaverId }, select: { name: true, nickname: true } }),
        prisma.visit.count({ where: { personId: handoverToId, departedAt: null, deletedAt: null } }),
    ]);
    if (!named?.email || open > 0) return;
    const leaverName = escapeHtml(leaver?.nickname || leaver?.name || "A keyholder");
    const when = formatDateTime(new Date(), { timeZone: await resolveDisplayTimezone() });
    const inside = othersInside === 1 ? "1 person is" : `${othersInside} people are`;
    await sendEmail(
        named.email,
        "You were named as the keyholder in charge",
        `<p>${leaverName} checked out at ${when} and named you as the keyholder they handed the building over to.</p>` +
        `<p>${inside} still recorded inside, and no keyholder is checked in. If you are there, check in; if not, let them know.</p>`,
    );
}

/**
 * Run the facility-wide visit close + post-event email kick AFTER the scan
 * route's per-participant transaction has committed — off the advisory lock.
 *
 * processCheckout (under the lock, on the tx client) only *decides* whether the
 * facility closed and reports it via `facilityClosed` in the response body; the
 * route hands that response here once committed. The sweep is retried once (it
 * can lose a lock race against an in-flight check-in); a second failure lands in
 * ErrorLog, never thrown, so it can't turn a committed checkout into a 500.
 */
export async function finalizeFacilityClose(res: Response, closer: FacilityCloser, closeTime: Date = new Date()): Promise<void> {
    let body: { facilityClosed?: boolean } | null;
    try {
        body = await res.clone().json();
    } catch {
        return; // non-JSON / empty body (e.g. debounce) — nothing to close
    }
    if (!body?.facilityClosed) return;
    await closeWithRetry(closer, closeTime);
}

async function closeWithRetry(closer: FacilityCloser, closeTime: Date = new Date()): Promise<void> {
    try {
        await runFacilityClose(closer, closeTime);
    } catch {
        try {
            await runFacilityClose(closer, closeTime);
        } catch (err) {
            await logBackendError(err, "facility-close");
        }
    }
}

/**
 * Send the check-in/out email for a committed scan. Runs only after the scan
 * transaction commits, so a rollback can't leave a false email and a retried
 * (duplicate_ignored) scan can't send a second one. `at` is the scan's event
 * time, so a replayed or held scan reports when it happened.
 */
export async function notifyScanOutcome(res: Response, at: Date): Promise<void> {
    let body: { type?: string; participant?: { id?: number }; visit?: unknown } | null;
    try {
        body = await res.clone().json();
    } catch {
        return;
    }
    const personId = body?.participant?.id;
    if (typeof personId !== "number") return;
    // A close-offer confirm departs nobody (closeOnOfferConfirm): the keyholder
    // already left, and got their checkout email then.
    if (body?.visit === null) return;
    if (body?.type === "checkin") {
        sendCheckinNotifications(personId, "checkin", "SCANNER", at).catch(err =>
            console.error("Checkin notification error:", err)
        );
    } else if (body?.type === "checkout") {
        sendCheckinNotifications(personId, "checkout", undefined, at).catch(err =>
            console.error("Checkout notification error:", err)
        );
    }
}
