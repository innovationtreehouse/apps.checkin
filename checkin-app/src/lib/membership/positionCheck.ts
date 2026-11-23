import type { PersonRoleKind } from "@/generated/prisma/client";
import { ServiceError, type StuckItem } from "@checkin/component-kit";
import { personActor } from "@/lib/auditActor";
import { config } from "@/lib/config";
import type { DbClient, TxClient } from "@/lib/db-client";
import { sendTemplated } from "@/lib/email-templates/send";
import { logger } from "@/lib/logger";
import prisma from "@/lib/prisma";
import { isYouth } from "@/lib/time";
import { checkStanding, checkValidFor, loadCheckReviews } from "@/lib/membership/checkStanding";
import { liveMembershipYear } from "@/lib/programYear";
import { CHECK_ACKNOWLEDGEMENT_CODE } from "@/lib/membership/positionCheckCode";

/**
 * Assigning a position that needs a current background check to someone whose check
 * is not current: the assigner is warned and must acknowledge, the acknowledgement is
 * audited, and the assignee is emailed how to start a check. Nothing is refused.
 */

const ACK_TABLE = "BG_CHECK_ACKNOWLEDGED";
const EMAIL_TABLE = "BG_CHECK_EMAIL";
export const CHECK_EMAIL_STEP = "check email";

const ROLE_POSITION_LABELS = {
    SYSADMIN: "Sysadmin",
    BOARD: "Board member",
    KEYHOLDER: "Keyholder",
    BG_REVIEWER: "Background-check reviewer",
    OPERATIONS: "Operations",
    INVENTORY_MANAGER: "Inventory manager",
    FINANCE: "Finance",
    KEY_VOLUNTEER: "Key Volunteer",
} as const satisfies Record<PersonRoleKind, string>;

/** Every position that needs a current check, by the name the audit row and the email use. */
export const POSITION_LABELS = {
    ...ROLE_POSITION_LABELS,
    BUDGET_OWNER: "Budget bucket owner",
    BUDGET_TREASURER: "Budget bucket treasurer",
} as const;

export type Position = keyof typeof POSITION_LABELS;

/** The earliest check date valid at the start of the membership year served now; null while the Board has set no interval or boundary. */
export async function positionCheckThreshold(db: DbClient, now = new Date()): Promise<Date | null> {
    const settings = await db.boardSettings.findUnique({ where: { id: 1 }, select: { orgMembershipYearBoundary: true } });
    return checkValidFor(liveMembershipYear(settings?.orgMembershipYearBoundary, now), db);
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

type EmailOutcome = { ok?: boolean; ackIds?: number[] };

/**
 * Sends the assignee one email naming every position in `ackIds` (one assignment's
 * acknowledgements, all for the same person) and records the outcome under the first
 * id, attributed to `actorId`. A failed send stays stuck on the Problems list until
 * someone presses Retry. Never throws.
 */
export async function sendCheckEmail(ackIds: readonly number[], actorId: number): Promise<boolean> {
    let ok = false;
    try {
        const acks = await prisma.auditLog.findMany({ where: { id: { in: [...ackIds] }, tableName: ACK_TABLE }, select: { affectedEntityId: true, newData: true }, orderBy: { id: "asc" } });
        const positions = acks
            .map((a) => (a.newData as { position?: string } | null)?.position)
            .filter((p): p is Position => !!p && p in POSITION_LABELS)
            .map((p) => POSITION_LABELS[p]);
        const person = acks.length ? await prisma.person.findUnique({ where: { id: acks[0].affectedEntityId }, select: { name: true, email: true } }) : null;
        if (person?.email && positions.length) {
            ok = await sendTemplated("membership.positionNeedsCheck", person.email, {
                name: person.name,
                positions: positions.join(", "),
                actionLink: `${config.baseUrl()}/membership`,
            });
        }
    } catch (err) {
        logger.error(`[position check] email for acknowledgements ${ackIds.join(", ")} failed:`, err);
    }
    try {
        await prisma.auditLog.create({
            data: { ...personActor(actorId), action: "CREATE", tableName: EMAIL_TABLE, affectedEntityId: ackIds[0], newData: { ok, ackIds: [...ackIds] } },
        });
    } catch (err) {
        logger.error(`[position check] could not record the email outcome for acknowledgements ${ackIds.join(", ")}:`, err);
    }
    return ok;
}

/** Sends the one email an assignment's acknowledgements owe, once the assignment has committed. */
export async function emailAfterAssignment(ackIds: readonly number[], actorId: number): Promise<void> {
    if (ackIds.length) await sendCheckEmail(ackIds, actorId);
}

/** Each failed email not since sent, as its acknowledgement ids, keyed by the first, with its first failure. */
async function stuckEmails(): Promise<Map<number, { ackIds: number[]; failedAt: Date }>> {
    const rows = await prisma.auditLog.findMany({
        where: { tableName: EMAIL_TABLE },
        select: { affectedEntityId: true, newData: true, timestamp: true },
        orderBy: { id: "asc" },
    });
    const failed = new Map<number, { ackIds: number[]; failedAt: Date }>();
    const sent = new Set<number>();
    for (const r of rows) {
        const outcome = (r.newData ?? {}) as EmailOutcome;
        if (outcome.ok === true) sent.add(r.affectedEntityId);
        else if (!failed.has(r.affectedEntityId)) failed.set(r.affectedEntityId, { ackIds: outcome.ackIds ?? [r.affectedEntityId], failedAt: r.timestamp });
    }
    for (const id of sent) failed.delete(id);
    return failed;
}

/** Each email that failed and has not since gone out, timed by its first failure. */
export async function checkEmailStuckItems(): Promise<StuckItem[]> {
    return [...(await stuckEmails())].map(([id, { failedAt }]) => ({ id: String(id), step: CHECK_EMAIL_STEP, href: "/membership-ops/roles", failedAt }));
}

/** Retry for a stuck check email: 404 when it isn't stuck, 409 when it fails again. */
export async function retryCheckEmail(item: { id: string; step: string }, by: { userId: number }): Promise<void> {
    const stuck = item.step === CHECK_EMAIL_STEP ? (await stuckEmails()).get(Number(item.id)) : undefined;
    if (!stuck) throw new ServiceError(404, "No such stuck item");
    if (!(await sendCheckEmail(stuck.ackIds, by.userId))) throw new ServiceError(409, "The email failed again");
}
