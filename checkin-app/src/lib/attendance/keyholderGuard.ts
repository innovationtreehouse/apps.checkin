import prisma from "@/lib/prisma";
import type { FacilityCloseVia, Person } from "@/generated/prisma/client";
import type { DbClient } from "@/lib/db-client";
import { KEYHOLDER_IN_BUILDING, LIVE_KEYHOLDER } from "@/lib/visit/filters";
import { getKioskDisplayNames } from "@/lib/kiosk-names";
import { randomUUID } from "node:crypto";
import { constantTimeEqual } from "@/lib/signatureCompare";
import { logBackendError } from "@/lib/logger";
import { personActor } from "@/lib/auditActor";
import type { AuthenticatedUser } from "@/types/auth";
import { sendTemplated } from "@/lib/email-templates/send";
import { formatDateTime } from "@/lib/time";
import { resolveDisplayTimezone } from "@/lib/appSettings";
import { executePendingCloses, recordClose } from "@/lib/attendance/close";

/**
 * The "others are here" list on a force-close warning, labelled as the kiosk
 * roster labels people: nickname, else first name, a last initial only to tell
 * two apart, else the email local-part. Never a last name or an address — the
 * badge path renders it on the public kiosk screen (docs/rules/attendance-checkin.md,
 * "The kiosk"). Keyed by visit id, which is unique per row.
 */
export function presentLabels(visits: { id: number; person: Pick<Person, "name" | "nickname" | "email"> }[]): string[] {
    const labels = getKioskDisplayNames(visits.map(v => ({ ...v.person, id: v.id })));
    return visits.flatMap(v => labels.get(v.id) || []);
}

/** Seconds a close offer counts down, at the kiosk and in the web dialog. The
 *  kiosk times its same-badge-again window itself; a web confirm is bounded by
 *  {@link WEB_CLOSE_CHOICE_TTL_MS}, not by this. */
export const FORCE_CLOSE_CONFIRM_SECONDS = 15;

/** How long a web close-choice dialog's answer is accepted; an older one was
 *  shown against a building that may have changed since. */
export const WEB_CLOSE_CHOICE_TTL_MS = 5 * 60_000;

/** Timing-safe force-close token compare. */
export function forceCloseTokenMatches(stored: string | null | undefined, given: string | null | undefined): boolean {
    return stored != null && given != null && constantTimeEqual(stored, given);
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

/** Only a keyholder closes the building (Arts. VI–VII): checking themselves
 *  out, or, on the board, checking out the last keyholder. */
const mayClose = (actor: CloseActor, subjectId: number) => actor.isKeyholder && (actor.id === subjectId || actor.isBoardMember);

/** Keyholders, the board and sysadmins already read the full roster. */
const readsRoster = (actor: CloseActor) => actor.isKeyholder || actor.isBoardMember || actor.isSysadmin;

/** Live keyholders other than the leaver with no open visit: who a leave can name. */
async function handoverCandidates(db: DbClient, subjectId: number) {
    const people = await db.person.findMany({
        where: { ...LIVE_KEYHOLDER, id: { not: subjectId }, visits: { none: { departedAt: null, deletedAt: null } } },
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
 * - a keyholder checking themselves out, or a board member who is a keyholder,
 *   gets all three; a leave names the keyholder handed over to, unless no
 *   keyholder is free to name;
 * - anyone else — another keyholder, a board member who is not a keyholder, a
 *   household lead, a sysadmin — gets leave or cancel and names nobody;
 * - a removal never closes, whoever makes it.
 *
 * The token is bound to the actor shown the choice and expires after
 * {@link WEB_CLOSE_CHOICE_TTL_MS}, and the allowed choices are worked out again
 * on confirm, so a role revoked in between takes effect. The
 * token columns belong to this dialog alone; no kiosk path reads them.
 * A keyholder alone in the record closes with no warning when the caller may
 * close. Callers depart or remove the visit, recording the close in the same
 * transaction ({@link recordWebClose}), then call {@link finishCloseGuard}.
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
        where: { ...KEYHOLDER_IN_BUILDING, id: { not: visitId } }
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
        select: { forceCloseToken: true, forceCloseActorId: true, forceCloseWarnedAt: true },
    });
    const token = typeof confirm.token === "string" ? confirm.token : null;
    const confirmed = visit?.forceCloseActorId === actor.id && forceCloseTokenMatches(visit.forceCloseToken, token)
        && visit.forceCloseWarnedAt != null && Date.now() - visit.forceCloseWarnedAt.getTime() <= WEB_CLOSE_CHOICE_TTL_MS;

    // A token that does not answer this caller's open choice — spent, replaced,
    // stale, or shown to someone else — is refused, never re-bound to this caller.
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
                    where: { ...LIVE_KEYHOLDER, id: confirm.handoverToId, NOT: { id: subject.id } },
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
 * Record the close a web caller chose, on `db` — the transaction that checks the
 * visit out, so the checkout and the close commit together. It runs after the
 * checkout, so it can link the closer's departed visit. False when the caller
 * did not choose a close.
 */
export async function recordWebClose(
    db: DbClient,
    guard: Extract<CloseGuardResult, { action: "proceed" }>,
    ctx: { actorId: number; subjectId: number; via: FacilityCloseVia; closeTime?: Date },
): Promise<boolean> {
    if (!guard.facilityClosed) return false;
    await recordClose(db, { closedById: ctx.actorId, via: ctx.via, ownCheckout: ctx.actorId === ctx.subjectId }, ctx.closeTime ?? new Date());
    return true;
}

/**
 * After the guarded visit is departed or removed: carry out the close the caller
 * chose (recording it first unless the caller already did, `recorded`), audit
 * the choice, and email a named keyholder who is not checked in. Never throws;
 * the checkout has already committed.
 */
export async function finishCloseGuard(
    guard: Extract<CloseGuardResult, { action: "proceed" }>,
    ctx: { actorId: number; subjectId: number; visitId: number; via: FacilityCloseVia; closeTime?: Date; recorded?: boolean },
): Promise<void> {
    if (guard.facilityClosed) {
        if (!ctx.recorded) {
            try {
                await recordWebClose(prisma, guard, ctx);
            } catch (err) {
                await logBackendError(err, "facility-close");
            }
        }
        await executePendingCloses();
    }
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
    const leaverName = leaver?.nickname || leaver?.name || "A keyholder";
    const when = formatDateTime(new Date(), { timeZone: await resolveDisplayTimezone() });
    const peopleInside = othersInside === 1 ? "1 person is" : `${othersInside} people are`;
    await sendTemplated("attendance.keyholderHandover", named.email, { leaverName, when, peopleInside });
}
