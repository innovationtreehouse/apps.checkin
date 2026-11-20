import type { PersonRoleKind } from "@/generated/prisma/client";
import { ServiceError, type StuckItem } from "@checkin/component-kit";
import { personActor } from "@/lib/auditActor";
import { config } from "@/lib/config";
import type { DbClient, TxClient } from "@/lib/db-client";
import { sendTemplated } from "@/lib/email-templates/send";
import { logger } from "@/lib/logger";
import prisma from "@/lib/prisma";
import { isYouth } from "@/lib/time";
import { checkStanding, liveBgThreshold, loadCheckReviews } from "@/lib/membership/checkStanding";
import { CHECK_ACKNOWLEDGEMENT_CODE } from "@/lib/membership/positionCheckCode";

/**
 * Assigning a position that needs a current background check to someone whose check
 * is not current: the assigner is warned and must acknowledge, the acknowledgement is
 * audited, and the assignee is emailed how to start a check. Nothing is refused.
 */

const ACK_TABLE = "BG_CHECK_ACKNOWLEDGED";
const EMAIL_TABLE = "BG_CHECK_EMAIL";
export const CHECK_EMAIL_STEP = "check email";

/** Every position that needs a current check, by the name the audit row and the email use. */
export const POSITION_LABELS = {
    SYSADMIN: "Sysadmin",
    BOARD: "Board member",
    KEYHOLDER: "Keyholder",
    BG_REVIEWER: "Background-check reviewer",
    OPERATIONS: "Operations",
    INVENTORY_MANAGER: "Inventory manager",
    FINANCE: "Finance",
    KEY_VOLUNTEER: "Key Volunteer",
} as const satisfies Record<PersonRoleKind, string>;

export type Position = keyof typeof POSITION_LABELS;

/** The earliest check date that counts for a position served now; null while the Board has set no interval. */
export function positionCheckThreshold(db: DbClient, now = new Date()): Promise<Date | null> {
    return liveBgThreshold(db, now);
}

/** Whether `personId` lacks a current check that a position needs. Under-18s are never checked; an unknown age counts as adult. */
export async function lacksCurrentCheck(db: DbClient, personId: number, now = new Date()): Promise<boolean> {
    const person = await db.person.findUnique({ where: { id: personId }, select: { dateOfBirth: true, lastBackgroundCheck: true } });
    if (!person || isYouth(person.dateOfBirth)) return false;
    const [threshold, reviews] = await Promise.all([positionCheckThreshold(db, now), loadCheckReviews(db, [personId])]);
    return checkStanding(person.lastBackgroundCheck, reviews.get(personId) ?? [], threshold) !== "CLEARED";
}

/**
 * The shared gate every assignment path runs inside its transaction. A person with a
 * current check passes with null. Otherwise it throws a 409 carrying
 * CHECK_ACKNOWLEDGEMENT_CODE until `acknowledged`, then writes the acknowledgement's
 * audit row and returns its id, for `emailAfterAssignment` once the transaction commits.
 */
export async function gatePositionCheck(
    tx: TxClient,
    { personId, position, actorId, acknowledged }: { personId: number; position: Position; actorId: number; acknowledged: boolean },
): Promise<number | null> {
    if (!(await lacksCurrentCheck(tx, personId))) return null;
    if (!acknowledged) {
        throw new ServiceError(409, "This person isn't current on their background check, which this position needs. Acknowledge to assign it anyway; they'll be emailed how to start a check.", CHECK_ACKNOWLEDGEMENT_CODE);
    }
    const row = await tx.auditLog.create({
        data: { ...personActor(actorId), action: "CREATE", tableName: ACK_TABLE, affectedEntityId: personId, newData: { position } },
        select: { id: true },
    });
    return row.id;
}

/**
 * Sends the assignee the one email an acknowledgement owes and records the outcome,
 * attributed to `actorId`. A failed send leaves the acknowledgement stuck on the
 * Problems list until someone presses Retry. Never throws.
 */
export async function sendCheckEmail(ackId: number, actorId: number): Promise<boolean> {
    let ok = false;
    try {
        const ack = await prisma.auditLog.findFirst({ where: { id: ackId, tableName: ACK_TABLE }, select: { affectedEntityId: true, newData: true } });
        const position = (ack?.newData as { position?: Position } | null)?.position;
        const person = ack ? await prisma.person.findUnique({ where: { id: ack.affectedEntityId }, select: { name: true, email: true } }) : null;
        if (person?.email && position && position in POSITION_LABELS) {
            ok = await sendTemplated("membership.positionNeedsCheck", person.email, {
                name: person.name,
                position: POSITION_LABELS[position],
                actionLink: `${config.baseUrl()}/membership`,
            });
        }
    } catch (err) {
        logger.error(`[position check] email for acknowledgement ${ackId} failed:`, err);
    }
    try {
        await prisma.auditLog.create({
            data: { ...personActor(actorId), action: "CREATE", tableName: EMAIL_TABLE, affectedEntityId: ackId, newData: { ok } },
        });
    } catch (err) {
        logger.error(`[position check] could not record the email outcome for acknowledgement ${ackId}:`, err);
    }
    return ok;
}

/** Sends each acknowledgement's email, once its assignment has committed. */
export async function emailAfterAssignment(ackIds: readonly number[], actorId: number): Promise<void> {
    for (const id of ackIds) await sendCheckEmail(id, actorId);
}

/** Each acknowledgement whose email has failed and not since gone out, timed by its first failure. */
export async function checkEmailStuckItems(): Promise<StuckItem[]> {
    const rows = await prisma.auditLog.findMany({
        where: { tableName: EMAIL_TABLE },
        select: { affectedEntityId: true, newData: true, timestamp: true },
        orderBy: { id: "asc" },
    });
    const firstFailure = new Map<number, Date>();
    const sent = new Set<number>();
    for (const r of rows) {
        if ((r.newData as { ok?: boolean } | null)?.ok === true) sent.add(r.affectedEntityId);
        else if (!firstFailure.has(r.affectedEntityId)) firstFailure.set(r.affectedEntityId, r.timestamp);
    }
    return [...firstFailure]
        .filter(([ackId]) => !sent.has(ackId))
        .map(([ackId, failedAt]) => ({ id: String(ackId), step: CHECK_EMAIL_STEP, href: "/membership-ops/roles", failedAt }));
}

/** Retry for a stuck check email: 404 when it isn't stuck, 409 when it fails again. */
export async function retryCheckEmail(item: { id: string; step: string }, by: { userId: number }): Promise<void> {
    const stuck = (await checkEmailStuckItems()).some((i) => i.id === item.id && i.step === item.step);
    if (!stuck) throw new ServiceError(404, "No such stuck item");
    if (!(await sendCheckEmail(Number(item.id), by.userId))) throw new ServiceError(409, "The email failed again");
}
