import prisma from "@/lib/prisma";
import { ServiceError } from "@checkin/component-kit";
import { isLiveHousehold } from "@/lib/household/archived";
import { ARCHIVED_HOUSEHOLD_REFUSAL, ArchivedHouseholdError, lockHouseholdRows, lockLiveHouseholds } from "@/lib/household/archiveGuard";
import { TRUSTED_ADULT_ERROR_STATUS } from "@/lib/domainErrorResponse";
import { personActor, systemActor, type AuditActor } from "@/lib/auditActor";
import { emailBoardMembers, emailHouseholdLeads } from "@/lib/emailRecipients";
import type { TemplateCtx, TemplateKey } from "@/lib/email-templates/registry";
import { trustedAdultConflictReason } from "@/lib/trusted-adult/conflict";
import { recordSelfGrantRefusal, type SelfGrantRefusal } from "@/lib/membership/selfGrantGuard";
import { authorizedReview, expiringApprovals, isAuthorizedApproval } from "@/lib/trusted-adult/filters";
import { config } from "@/lib/config";
import { validateContact } from "@/lib/trusted-adult/contact";
import { lockAndFindDeniedHousehold } from "@/lib/membership/householdStatus";
import { householdLeadsWhere } from "@/lib/household/leads";
import type { DbClient, TxClient } from "@/lib/db-client";

/**
 * Serialize all mutations of one TrustedAdult by taking a row lock on the parent.
 * renew/withdraw/decide each read-check-write; without this lock two concurrent
 * calls both pass the check and both write (TOCTOU). Mirrors lib/membership/review.ts.
 */
function lockTrustedAdult(tx: TxClient, taId: number) {
    return tx.$queryRaw`SELECT id FROM "TrustedAdult" WHERE id = ${taId} FOR UPDATE`;
}

/** Locks the household a review opens on, so an archive cannot land beside the new review. */
async function lockLiveHousehold(tx: TxClient, householdId: number) {
    try {
        await lockLiveHouseholds(tx, [householdId]);
    } catch (e) {
        if (e instanceof ArchivedHouseholdError) throw new TrustedAdultError("wrong_phase", ARCHIVED_HOUSEHOLD_REFUSAL);
        throw e;
    }
}

/**
 * Trusted Adult management.
 *
 * A Trusted Adult is an outside adult a HOUSEHOLD authorizes (e.g. "Grandma can
 * pick up the Smith kids"). Policy refers to these as "dual relationships"; the
 * member-facing name is Trusted Adult. The board reviews each disclosure; a
 * SINGLE board member's decision settles a review (no quorum). Approval is valid
 * for one year — the household leads are warned 30 days out and can resubmit in
 * one click without re-entering anything.
 *
 * Two notes, different audiences:
 *   - familyContext  (on TrustedAdult)        — the family's explanation FOR the
 *       board (what the adult may/may not do). Board + the household only.
 *   - sharedNote     (on TrustedAdultReview)  — the board's note shared OUTWARD on
 *       approval ("Grandma can pick up Bobby"). Required to approve. Seen by the
 *       family, board, the household's program leads, and keyholders.
 *
 * Status machine (TrustedAdultReview.status):
 *   PENDING_BOARD_REVIEW ──► APPROVED | DENIED
 *                        └─► PENDING_SUBJECT_ACTION (board asked for info)
 *   PENDING_SUBJECT_ACTION ──(household answers)──► PENDING_BOARD_REVIEW (same review)
 *   APPROVED ──(reviewBy passes)──► EXPIRED ──(renew)──► new PENDING_BOARD_REVIEW
 *   APPROVED ──(a later review on the adult is approved)──► SUPERSEDED
 *   APPROVED (in force) | DENIED ──(board reset)──► PENDING_BOARD_REVIEW
 *   SUPERSEDED ──(the approval that replaced it is reset)──► APPROVED
 *   any non-terminal ──(household withdraws / board revoke)──► REVOKED
 */

const APPROVAL_VALID_DAYS = 365;
const WARN_LEAD_DAYS = 30;

export class TrustedAdultError extends ServiceError {
    constructor(
        public readonly code:
            | "not_found"
            | "bad_input"
            | "wrong_phase"
            | "forbidden"
            | "already_open",
        message: string,
    ) {
        super(TRUSTED_ADULT_ERROR_STATUS[code], message, code);
        this.name = "TrustedAdultError";
    }
}

/** A conflict refused inside a transaction; `conflictCheckedTransaction` records it after the rollback. */
class ConflictRefusedError extends TrustedAdultError {
    constructor(public readonly refusal: SelfGrantRefusal, message: string) {
        super("forbidden", message);
    }
}

async function conflictCheckedTransaction<T>(fn: (tx: TxClient) => Promise<T>): Promise<T> {
    try {
        return await prisma.$transaction(fn);
    } catch (e) {
        if (e instanceof ConflictRefusedError) await recordSelfGrantRefusal(prisma, e.refusal);
        throw e;
    }
}

function daysFromNow(base: Date, days: number): Date {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() + days);
    return d;
}

export interface CreateInput {
    householdId: number;
    trustedAdultPersonId?: number | null;
    trustedAdultName: string;
    trustedAdultPhone?: string | null;
    trustedAdultEmail?: string | null;
    /** The family's board-facing explanation of what the adult may/may not do. */
    familyContext: string;
    origin?: "SELF_DISCLOSED" | "STAFF_ENTERED";
    disclosedById: number;
}

/**
 * Create a Trusted Adult for a household plus its INITIAL review
 * (PENDING_BOARD_REVIEW). Name, at least one contact (phone or email), and the
 * family's board-facing context are all required.
 */
export async function createTrustedAdult(input: CreateInput) {
    if (!input.trustedAdultName?.trim()) {
        throw new TrustedAdultError("bad_input", "The trusted adult's name is required.");
    }
    const contact = validateContact({ phone: input.trustedAdultPhone, email: input.trustedAdultEmail });
    if ("error" in contact) {
        throw new TrustedAdultError("bad_input", contact.error);
    }
    if (!input.familyContext?.trim()) {
        throw new TrustedAdultError("bad_input", "Tell the board what this adult may or may not do.");
    }

    const household = await prisma.household.findUnique({ where: { id: input.householdId }, select: { id: true } });
    if (!household) throw new TrustedAdultError("not_found", "Household not found.");

    const ta = await prisma.$transaction(async (tx) => {
        // Locks the membership rows a denial updates: a concurrent deny either lands first and is seen here,
        // or waits and then revokes the review this creates. Membership rows before the household row,
        // the order archiving takes them in.
        const households = await adultHouseholdIds(tx, { householdId: input.householdId, trustedAdultPersonId: input.trustedAdultPersonId ?? null });
        if ((await lockAndFindDeniedHousehold(tx, households)) !== null) {
            throw new TrustedAdultError("wrong_phase", "This household has been denied membership, so this trusted adult cannot be added.");
        }
        await lockLiveHousehold(tx, input.householdId);
        const created = await tx.trustedAdult.create({
            data: {
                householdId: input.householdId,
                trustedAdultPersonId: input.trustedAdultPersonId ?? null,
                trustedAdultName: input.trustedAdultName.trim(),
                trustedAdultPhone: contact.phone,
                trustedAdultEmail: contact.email,
                familyContext: input.familyContext.trim(),
                origin: input.origin ?? "SELF_DISCLOSED",
                disclosedById: input.disclosedById,
                reviews: {
                    create: { householdId: input.householdId, kind: "INITIAL", status: "PENDING_BOARD_REVIEW" },
                },
            },
            include: { reviews: true },
        });
        await audit(tx, personActor(input.disclosedById), created.id, {}, { created: true, status: "PENDING_BOARD_REVIEW" }, "CREATE");
        return created;
    });

    await notifyBoard();
    return ta;
}

/**
 * Open a RENEWAL review against an existing Trusted Adult, reusing every fact on
 * file (no re-entry). Allowed only when no review is already in flight and any live
 * approval is inside its expiry warning window. Callable by a lead of the household.
 */
export async function renewTrustedAdult(id: number, actorId: number) {
    const ta = await prisma.trustedAdult.findUnique({ where: { id }, select: { id: true, householdId: true, trustedAdultPersonId: true } });
    if (!ta) throw new TrustedAdultError("not_found", "Trusted adult not found.");
    await assertHouseholdLead(ta.householdId, actorId);

    // Lock the parent, re-read the latest review under the lock, then create. Without
    // the lock two concurrent renews both see a terminal latest and both open a review.
    const review = await prisma.$transaction(async (tx) => {
        await lockLiveHousehold(tx, ta.householdId);
        await lockTrustedAdult(tx, ta.id);
        const latest = await tx.trustedAdultReview.findFirst({ where: { trustedAdultId: ta.id }, orderBy: { id: "desc" } });
        if (latest && (latest.status === "PENDING_BOARD_REVIEW" || latest.status === "PENDING_SUBJECT_ACTION")) {
            throw new TrustedAdultError("already_open", "A review for this trusted adult is already in progress.");
        }
        if (await adultHouseholdDenied(tx, ta)) {
            throw new TrustedAdultError("wrong_phase", "This household has been denied membership, so this trusted adult cannot be renewed.");
        }
        // A renewal adds a year to the current end, so it opens only once the expiry warning window does.
        const now = new Date();
        const current = await tx.trustedAdultReview.aggregate({
            where: { trustedAdultId: ta.id, ...authorizedReview(now) },
            _max: { reviewBy: true },
        });
        const end = current._max.reviewBy;
        if (end && end > daysFromNow(now, WARN_LEAD_DAYS)) {
            throw new TrustedAdultError(
                "wrong_phase",
                `This approval runs until ${end.toISOString().slice(0, 10)}. You can renew it from ${WARN_LEAD_DAYS} days before then.`,
            );
        }
        const created = await tx.trustedAdultReview.create({
            data: { trustedAdultId: ta.id, householdId: ta.householdId, kind: "RENEWAL", status: "PENDING_BOARD_REVIEW" },
        });
        await audit(tx, personActor(actorId), ta.id, {}, { renewal: created.id, status: "PENDING_BOARD_REVIEW" }, "CREATE");
        return created;
    });
    await notifyBoard();
    return review;
}

export interface ResubmitInput {
    trustedAdultName: string;
    trustedAdultPhone?: string | null;
    trustedAdultEmail?: string | null;
    /** The family's board-facing explanation of what the adult may/may not do. */
    familyContext: string;
}

/**
 * Open a MODIFIED review that carries the family's CHANGED facts about a trusted
 * adult. Unlike renew, the edited name/contact/context are NOT written to the
 * parent — they ride on the review (proposed* fields) and only promote onto the
 * parent when the board approves (see promoteProposal). This is deliberate: a
 * still-live prior approval keeps its own facts + shared note active for the front
 * desk until, and only if, the board approves the change. A deny leaves the prior
 * approval wholly intact. Allowed only when no review is already in flight.
 */
export async function resubmitWithChanges(id: number, actorId: number, input: ResubmitInput) {
    if (!input.trustedAdultName?.trim()) {
        throw new TrustedAdultError("bad_input", "The trusted adult's name is required.");
    }
    const contact = validateContact({ phone: input.trustedAdultPhone, email: input.trustedAdultEmail });
    if ("error" in contact) {
        throw new TrustedAdultError("bad_input", contact.error);
    }
    if (!input.familyContext?.trim()) {
        throw new TrustedAdultError("bad_input", "Tell the board what this adult may or may not do.");
    }

    const ta = await prisma.trustedAdult.findUnique({ where: { id }, select: { id: true, householdId: true, trustedAdultPersonId: true } });
    if (!ta) throw new TrustedAdultError("not_found", "Trusted adult not found.");
    await assertHouseholdLead(ta.householdId, actorId);

    const review = await prisma.$transaction(async (tx) => {
        await lockLiveHousehold(tx, ta.householdId);
        await lockTrustedAdult(tx, ta.id);
        const latest = await tx.trustedAdultReview.findFirst({ where: { trustedAdultId: ta.id }, orderBy: { id: "desc" } });
        if (latest && (latest.status === "PENDING_BOARD_REVIEW" || latest.status === "PENDING_SUBJECT_ACTION")) {
            throw new TrustedAdultError("already_open", "A review for this trusted adult is already in progress.");
        }
        if (await adultHouseholdDenied(tx, ta)) {
            throw new TrustedAdultError("wrong_phase", "This household has been denied membership, so changes to this trusted adult cannot be submitted.");
        }
        const created = await tx.trustedAdultReview.create({
            data: {
                trustedAdultId: ta.id,
                householdId: ta.householdId,
                kind: "MODIFIED",
                status: "PENDING_BOARD_REVIEW",
                proposedName: input.trustedAdultName.trim(),
                proposedPhone: contact.phone,
                proposedEmail: contact.email,
                proposedContext: input.familyContext.trim(),
            },
        });
        await audit(tx, personActor(actorId), ta.id, {}, { modified: created.id, status: "PENDING_BOARD_REVIEW" }, "CREATE");
        return created;
    });
    await notifyBoard();
    return review;
}

export interface AnswerInput extends ResubmitInput {
    /** The family's reply to the board's question. */
    reply?: string | null;
}

/**
 * A household lead answers the board's request for more information and sends the SAME
 * review back to PENDING_BOARD_REVIEW. Changed facts ride on the review as proposed*
 * (promoted only on approval), so a live earlier approval keeps its facts meanwhile.
 * Needs a reply, a change, or both.
 */
export async function answerInfoRequest(id: number, actorId: number, input: AnswerInput) {
    if (!input.trustedAdultName?.trim()) {
        throw new TrustedAdultError("bad_input", "The trusted adult's name is required.");
    }
    const contact = validateContact({ phone: input.trustedAdultPhone, email: input.trustedAdultEmail });
    if ("error" in contact) {
        throw new TrustedAdultError("bad_input", contact.error);
    }
    if (!input.familyContext?.trim()) {
        throw new TrustedAdultError("bad_input", "Tell the board what this adult may or may not do.");
    }
    const reply = input.reply?.trim() || null;

    const ta = await prisma.trustedAdult.findUnique({ where: { id }, select: { id: true, householdId: true, trustedAdultPersonId: true } });
    if (!ta) throw new TrustedAdultError("not_found", "Trusted adult not found.");
    await assertHouseholdLead(ta.householdId, actorId);

    const review = await prisma.$transaction(async (tx) => {
        await lockLiveHousehold(tx, ta.householdId);
        await lockTrustedAdult(tx, ta.id);
        const latest = await tx.trustedAdultReview.findFirst({ where: { trustedAdultId: ta.id }, orderBy: { id: "desc" } });
        if (!latest || latest.status !== "PENDING_SUBJECT_ACTION") {
            throw new TrustedAdultError("wrong_phase", "The board hasn't asked for more information on this trusted adult.");
        }
        if (await adultHouseholdDenied(tx, ta)) {
            throw new TrustedAdultError("wrong_phase", "This household has been denied membership, so this answer cannot be sent to the board.");
        }
        const parent = await tx.trustedAdult.findUniqueOrThrow({ where: { id: ta.id } });
        const current = latest.proposedName == null
            ? { name: parent.trustedAdultName, phone: parent.trustedAdultPhone, email: parent.trustedAdultEmail, context: parent.familyContext }
            : { name: latest.proposedName, phone: latest.proposedPhone, email: latest.proposedEmail, context: latest.proposedContext };
        const next = { name: input.trustedAdultName.trim(), phone: contact.phone, email: contact.email, context: input.familyContext.trim() };
        const changed = (Object.keys(next) as (keyof typeof next)[]).some((k) => next[k] !== current[k]);
        if (!changed && !reply) {
            throw new TrustedAdultError("bad_input", "Add a reply for the board or change the details.");
        }
        const updated = await tx.trustedAdultReview.update({
            where: { id: latest.id },
            data: {
                status: "PENDING_BOARD_REVIEW",
                ...(reply ? { familyReply: reply } : {}),
                ...(changed
                    ? { proposedName: next.name, proposedPhone: next.phone, proposedEmail: next.email, proposedContext: next.context }
                    : {}),
            },
        });
        await audit(
            tx,
            personActor(actorId),
            ta.id,
            { status: latest.status, reviewId: latest.id },
            { status: "PENDING_BOARD_REVIEW", reviewId: latest.id, answeredInfoRequest: true, reply, changedDetails: changed },
        );
        return updated;
    });
    await notifyBoard();
    return review;
}

/**
 * Retire every other approval on the adult when a review is approved, so the approved
 * review alone speaks for them. Runs under the parent lock, before the approval is written.
 */
async function supersedeOtherApprovals(tx: TxClient, actor: AuditActor, taId: number, approvedReviewId: number) {
    const others = await tx.trustedAdultReview.findMany({
        where: { trustedAdultId: taId, status: "APPROVED", id: { not: approvedReviewId } },
        select: { id: true },
        orderBy: { id: "asc" },
    });
    if (others.length === 0) return;
    await tx.trustedAdultReview.updateMany({ where: { id: { in: others.map((r) => r.id) } }, data: { status: "SUPERSEDED" } });
    for (const r of others) {
        await audit(tx, actor, taId, { status: "APPROVED", reviewId: r.id }, { status: "SUPERSEDED", reviewId: r.id, supersededBy: approvedReviewId });
    }
}

/**
 * Put back the approvals that a reset approval retired, so the adult keeps the approval
 * they held before it. The audit rows written by supersedeOtherApprovals name them.
 */
async function restoreSupersededBy(tx: TxClient, actor: AuditActor, taId: number, resetReviewId: number) {
    const retired = await tx.auditLog.findMany({
        where: { tableName: "TrustedAdult", affectedEntityId: taId, newData: { path: ["supersededBy"], equals: resetReviewId } },
        select: { newData: true },
    });
    const ids = retired.flatMap(({ newData: d }) =>
        d && typeof d === "object" && !Array.isArray(d) && typeof d.reviewId === "number" ? [d.reviewId] : [],
    );
    if (ids.length === 0) return;
    const live = await tx.trustedAdultReview.findMany({ where: { id: { in: ids }, status: "SUPERSEDED" }, select: { id: true }, orderBy: { id: "asc" } });
    if (live.length === 0) return;
    await tx.trustedAdultReview.updateMany({ where: { id: { in: live.map((r) => r.id) } }, data: { status: "APPROVED" } });
    for (const r of live) {
        await audit(tx, actor, taId, { status: "SUPERSEDED", reviewId: r.id }, { status: "APPROVED", reviewId: r.id, restoredByResetOf: resetReviewId });
    }
}

type AdultHouseholds = { householdId: number; trustedAdultPersonId: number | null };

/** The household that names the adult, and the household the adult belongs to. */
async function adultHouseholdIds(tx: TxClient, ta: AdultHouseholds) {
    const person = ta.trustedAdultPersonId
        ? await tx.person.findUnique({ where: { id: ta.trustedAdultPersonId }, select: { householdId: true } })
        : null;
    return person ? [ta.householdId, person.householdId] : [ta.householdId];
}

/** A denial of the adult's own household, or of the household they belong to. */
async function adultHouseholdDenied(tx: TxClient, ta: AdultHouseholds) {
    const householdIds = await adultHouseholdIds(tx, ta);
    return (await tx.orgMembership.count({ where: { householdId: { in: householdIds }, status: "DENIED" } })) > 0;
}

const CONFLICT_TA_SELECT = {
    householdId: true,
    trustedAdultPersonId: true,
    trustedAdultName: true,
    trustedAdultEmail: true,
    trustedAdultPhone: true,
    trustedAdultPerson: { select: { householdId: true } },
} as const;

interface ConflictReview {
    proposedEmail: string | null;
    proposedPhone: string | null;
    trustedAdult: {
        householdId: number;
        trustedAdultPersonId: number | null;
        trustedAdultEmail: string | null;
        trustedAdultPhone: string | null;
        trustedAdultPerson: { householdId: number } | null;
    };
}

/** The refusal the trusted-adult conflict rule makes of this actor on this review, or null. Writes nothing. */
async function findConflictRefusal(db: DbClient, actorId: number, reviewId: number, review: ConflictReview): Promise<SelfGrantRefusal | null> {
    const me = await db.person.findUnique({
        where: { id: actorId },
        select: { householdId: true, household: { select: { householdMembers: { select: { email: true, phone: true } } } } },
    });
    const ta = review.trustedAdult;
    const reason = trustedAdultConflictReason({
        actorParticipantId: actorId,
        actorHouseholdId: me?.householdId,
        actorHouseholdContacts: me?.household?.householdMembers ?? [],
        taHouseholdId: ta.householdId,
        adult: {
            personId: ta.trustedAdultPersonId,
            personHouseholdId: ta.trustedAdultPerson?.householdId,
            email: ta.trustedAdultEmail,
            phone: ta.trustedAdultPhone,
        },
        proposed: { email: review.proposedEmail, phone: review.proposedPhone },
    });
    return reason === null ? null : { actorId, affectedEntityId: reviewId, newData: { reason, table: "TrustedAdultReview" } };
}

/** Refuses, with a SelfGrantRefusal audit row, an actor the trusted-adult conflict rule bars from this review. */
async function refuseConflictedActor(actorId: number, reviewId: number, review: ConflictReview, message: string) {
    const refusal = await findConflictRefusal(prisma, actorId, reviewId, review);
    if (refusal === null) return;
    await recordSelfGrantRefusal(prisma, refusal);
    throw new TrustedAdultError("forbidden", message);
}

/**
 * Takes the parent lock and re-runs the conflict bar, which ran before it, on the review
 * as it stands. The actor's and the adult's household rows are locked first, as a
 * household move and a deny take them, and before the parent, as a deny does.
 */
async function lockAndRecheckConflict(tx: TxClient, taId: number, actorId: number, reviewId: number, message: string) {
    const readReview = () => tx.trustedAdultReview.findUnique({
        where: { id: reviewId },
        select: { proposedEmail: true, proposedPhone: true, trustedAdult: { select: CONFLICT_TA_SELECT } },
    });
    const before = await readReview();
    if (!before) throw new TrustedAdultError("not_found", "Review not found.");
    const actor = await tx.person.findUnique({ where: { id: actorId }, select: { householdId: true } });
    const ta = before.trustedAdult;
    await lockHouseholdRows(tx, [ta.householdId, ta.trustedAdultPerson?.householdId, actor?.householdId].filter((id): id is number => id != null));
    await lockTrustedAdult(tx, taId);
    const review = await readReview();
    if (!review) throw new TrustedAdultError("not_found", "Review not found.");
    const refusal = await findConflictRefusal(tx, actorId, reviewId, review);
    if (refusal) throw new ConflictRefusedError(refusal, message);
}

/**
 * Promote a review's proposed facts (a MODIFIED resubmission, or edits sent with an
 * answer to the board's question) onto the parent TrustedAdult. Called inside the
 * approval transaction only — the live approved facts stay put until the board
 * actually signs off on the change. No-op for a review that proposes nothing.
 */
function promoteProposal(
    tx: TxClient,
    review: { trustedAdultId: number; proposedName: string | null; proposedPhone: string | null; proposedEmail: string | null; proposedContext: string | null },
) {
    if (review.proposedName == null) return;
    return tx.trustedAdult.update({
        where: { id: review.trustedAdultId },
        data: {
            trustedAdultName: review.proposedName ?? undefined,
            trustedAdultPhone: review.proposedPhone,
            trustedAdultEmail: review.proposedEmail,
            familyContext: review.proposedContext ?? undefined,
        },
    });
}

/**
 * A household lead permanently hides a WITHDRAWN trusted adult from their own
 * view. The row stays in the DB (board history / audit); only the member-facing
 * /mine list filters on hiddenAt. Allowed only once the latest review is REVOKED —
 * matches the UI, and blocks a direct POST from hiding an active/pending record.
 */
export async function hideTrustedAdult(id: number, actorId: number) {
    const ta = await prisma.trustedAdult.findUnique({ where: { id }, select: { id: true, householdId: true, hiddenAt: true } });
    if (!ta) throw new TrustedAdultError("not_found", "Trusted adult not found.");
    await assertHouseholdLead(ta.householdId, actorId);
    if (ta.hiddenAt) return ta; // already hidden — idempotent

    return prisma.$transaction(async (tx) => {
        await lockTrustedAdult(tx, ta.id);
        const latest = await tx.trustedAdultReview.findFirst({ where: { trustedAdultId: ta.id }, orderBy: { id: "desc" } });
        if (!latest || latest.status !== "REVOKED") {
            throw new TrustedAdultError("wrong_phase", "Only a withdrawn trusted adult can be hidden.");
        }
        const updated = await tx.trustedAdult.update({ where: { id: ta.id }, data: { hiddenAt: new Date() } });
        await audit(tx, personActor(actorId), ta.id, { hiddenAt: null }, { hiddenAt: updated.hiddenAt });
        return updated;
    });
}

/**
 * A household lead withdraws a Trusted Adult — REVOKES every review that isn't
 * already revoked, not just the latest. A renewal opens a new review while the
 * prior approval stays live until that review is approved, so revoking only the
 * latest would leave the adult on the pickup list after withdrawal.
 */
export async function withdrawTrustedAdult(id: number, actorId: number, opts?: { latestReviewOnly?: boolean }) {
    const ta = await prisma.trustedAdult.findUnique({ where: { id }, select: { id: true, householdId: true } });
    if (!ta) throw new TrustedAdultError("not_found", "Trusted adult not found.");
    await assertHouseholdLead(ta.householdId, actorId);

    // "Cancel change request": revoke ONLY the pending review on top (the proposed
    // change), leaving any live prior approval standing. The revoke-all path below is
    // for withdrawing the adult outright; using it here would nuke an approval the
    // family only meant to keep while retracting an edit.
    if (opts?.latestReviewOnly) {
        return prisma.$transaction(async (tx) => {
            await lockTrustedAdult(tx, ta.id);
            const latest = await tx.trustedAdultReview.findFirst({ where: { trustedAdultId: ta.id }, orderBy: { id: "desc" } });
            if (!latest || (latest.status !== "PENDING_BOARD_REVIEW" && latest.status !== "PENDING_SUBJECT_ACTION")) {
                throw new TrustedAdultError("wrong_phase", "No pending change to cancel.");
            }
            await tx.trustedAdultReview.update({ where: { id: latest.id }, data: { status: "REVOKED" } });
            await audit(tx, personActor(actorId), ta.id, { status: latest.status }, { status: "REVOKED" });
            return { ...latest, status: "REVOKED" as const };
        });
    }

    // Lock the parent so withdraw serializes against renew and decide on the same TA.
    return prisma.$transaction(async (tx) => {
        await lockTrustedAdult(tx, ta.id);
        const live = await tx.trustedAdultReview.findMany({
            where: { trustedAdultId: ta.id, status: { not: "REVOKED" } },
            orderBy: { id: "desc" },
        });
        if (live.length === 0) throw new TrustedAdultError("wrong_phase", "Nothing to withdraw.");
        await tx.trustedAdultReview.updateMany({
            where: { id: { in: live.map((r) => r.id) } },
            data: { status: "REVOKED" },
        });
        for (const r of live) {
            await audit(tx, personActor(actorId), ta.id, { status: r.status }, { status: "REVOKED" });
        }
        return { ...live[0], status: "REVOKED" as const };
    });
}

export interface DecideInput {
    decision: "APPROVE" | "DENY" | "REQUEST_INFO";
    /** Required on APPROVE: the outward note keyholders & program leads will see. */
    sharedNote?: string | null;
    /** Board-private reasoning (never shown outside the board). */
    note?: string | null;
    /**
     * DENY only. When true, also REVOKE every live (APPROVED) review — "Deny &
     * Revoke": reject the adult entirely, not just the proposed change. When false
     * (plain "Deny"), a live prior approval is left intact and keeps authorizing the
     * adult at the front desk; only the reviewed submission is denied.
     */
    revokePriorApprovals?: boolean;
}

/**
 * When an approval of this review ends. It reads only stored dates, so a reset and a
 * fresh approval land on the same day and no board action extends it.
 *   - No earlier approval or expiry on the adult: a year from the family's submission.
 *   - A change (MODIFIED) while the earlier approval still runs past its submission: that end.
 *   - Otherwise a year from the later of the earlier end and the submission.
 */
async function approvalEnd(tx: TxClient, review: { id: number; trustedAdultId: number; kind: string; createdAt: Date }) {
    const earlier = await tx.trustedAdultReview.aggregate({
        where: { trustedAdultId: review.trustedAdultId, id: { lt: review.id }, status: { in: ["APPROVED", "EXPIRED", "SUPERSEDED"] } },
        _max: { reviewBy: true },
    });
    const previousEnd = earlier._max.reviewBy;
    if (!previousEnd || previousEnd <= review.createdAt) return daysFromNow(review.createdAt, APPROVAL_VALID_DAYS);
    return review.kind === "MODIFIED" ? previousEnd : daysFromNow(previousEnd, APPROVAL_VALID_DAYS);
}

/**
 * A board member decides a review (single entry, no quorum). Acts only on a
 * review awaiting board review.
 *   APPROVE       -> requires sharedNote; stamps effectiveFrom (now) + reviewBy (approvalEnd)
 *   DENY          -> DENIED
 *   REQUEST_INFO  -> PENDING_SUBJECT_ACTION (notify household)
 */
export async function decideReview(reviewId: number, boardMemberId: number, input: DecideInput) {
    // Pure input validation — independent of locked state, so do it before the tx.
    if (input.decision === "APPROVE" && !input.sharedNote?.trim()) {
        throw new TrustedAdultError(
            "bad_input",
            "A shared note (what keyholders & program leads should know, e.g. who can pick up whom) is required to approve.",
        );
    }
    if (!["APPROVE", "DENY", "REQUEST_INFO"].includes(input.decision)) {
        throw new TrustedAdultError("bad_input", "Unknown decision.");
    }

    const head = await prisma.trustedAdultReview.findUnique({
        where: { id: reviewId },
        select: { trustedAdultId: true, proposedEmail: true, proposedPhone: true, trustedAdult: { select: CONFLICT_TA_SELECT } },
    });
    if (!head) throw new TrustedAdultError("not_found", "Review not found.");

    // The UI disables the buttons off the same rule; this is the enforcement a direct POST meets.
    const conflictMessage = "You can't decide a trusted-adult review tied to your own household — another board member must.";
    await refuseConflictedActor(boardMemberId, reviewId, head, conflictMessage);

    // Lock the parent TA, then re-read the review under the lock and check its phase.
    // Without this two board members both read PENDING_BOARD_REVIEW, both update, and
    // both write an audit row — the loser leaving an orphan audit that contradicts state.
    const result = await conflictCheckedTransaction(async (tx) => {
        await lockAndRecheckConflict(tx, head.trustedAdultId, boardMemberId, reviewId, conflictMessage);
        const review = await tx.trustedAdultReview.findUnique({ where: { id: reviewId } });
        if (!review) throw new TrustedAdultError("not_found", "Review not found.");
        if (review.status !== "PENDING_BOARD_REVIEW") {
            throw new TrustedAdultError("wrong_phase", "This review is not awaiting board review.");
        }

        const now = new Date();
        const data: Record<string, unknown> = {
            decidedById: boardMemberId,
            decision: input.decision,
            decisionNote: input.note?.trim() || null,
        };
        let status: string;
        switch (input.decision) {
            case "APPROVE": {
                if (await adultHouseholdDenied(tx, head.trustedAdult)) {
                    throw new TrustedAdultError("wrong_phase", "This household has been denied membership, so its trusted-adult review cannot be approved.");
                }
                const end = await approvalEnd(tx, review);
                if (end <= now) {
                    throw new TrustedAdultError("wrong_phase", "This approval would already have lapsed — deny it and the family renews.");
                }
                status = "APPROVED";
                data.effectiveFrom = now;
                data.reviewBy = end;
                data.sharedNote = input.sharedNote!.trim();
                break;
            }
            case "DENY":
                status = "DENIED";
                break;
            default:
                status = "PENDING_SUBJECT_ACTION";
                break;
        }
        data.status = status;

        if (input.decision === "APPROVE") await supersedeOtherApprovals(tx, personActor(boardMemberId), review.trustedAdultId, reviewId);
        const updated = await tx.trustedAdultReview.update({ where: { id: reviewId }, data });
        // Approving a MODIFIED review is the moment its proposed edits become fact.
        if (input.decision === "APPROVE") await promoteProposal(tx, review);
        await audit(tx, personActor(boardMemberId), review.trustedAdultId, { status: review.status }, { status, decision: input.decision });
        // "Deny & Revoke": reject the adult outright. Revoke every approval, lapsed and retired
        // ones included, so the sweep cannot later tell the family it merely expired and a
        // later renewal cannot date itself from one.
        if (input.decision === "DENY" && input.revokePriorApprovals) {
            const live = await tx.trustedAdultReview.findMany({
                where: { trustedAdultId: review.trustedAdultId, status: { in: ["APPROVED", "SUPERSEDED"] } },
                orderBy: { id: "desc" },
            });
            if (live.length) {
                await tx.trustedAdultReview.updateMany({
                    where: { id: { in: live.map((r) => r.id) } },
                    data: { status: "REVOKED" },
                });
                for (const r of live) {
                    await audit(tx, personActor(boardMemberId), review.trustedAdultId, { status: r.status }, { status: "REVOKED", revokedWithDenial: reviewId });
                }
            }
        }
        return { updated, householdId: review.householdId };
    });

    if (input.decision === "REQUEST_INFO") {
        await notifyHouseholdFamily(result.householdId, "trustedAdult.requestInfo", { note: input.note?.trim() ?? "", actionLink: trustedAdultsUrl() });
    }
    // Every denial notifies the family. The message depends on what survives the deny:
    // a live approval left standing (a rejected change), nothing left (a plain rejection),
    // or a deliberate full revocation.
    if (input.decision === "DENY") {
        const name = head.trustedAdult.trustedAdultName?.trim() || "your trusted adult";
        if (input.revokePriorApprovals) {
            await notifyHouseholdFamily(
                result.householdId,
                "trustedAdult.deniedRevoked",
                { adultName: name, actionLink: trustedAdultsUrl() },
            );
        } else {
            // Mirror /operational's rule: a surviving authorized review keeps the adult listed.
            const live = await prisma.trustedAdultReview.findFirst({
                where: { trustedAdultId: head.trustedAdultId, ...authorizedReview(new Date()) },
                orderBy: { reviewBy: "desc" },
            });
            if (live) {
                const until = live.reviewBy ? ` (valid until ${live.reviewBy.toISOString().slice(0, 10)})` : "";
                await notifyHouseholdFamily(
                    result.householdId,
                    "trustedAdult.changeNotApproved",
                    { adultName: name, until, actionLink: trustedAdultsUrl() },
                );
            } else {
                await notifyHouseholdFamily(
                    result.householdId,
                    "trustedAdult.notApproved",
                    { adultName: name, actionLink: trustedAdultsUrl() },
                );
            }
        }
    }
    return result.updated;
}

const OVERRIDE_CONFLICT_MESSAGE = "You can't override a trusted-adult review tied to your own household — someone outside your household must.";

/** The review an override acts on, with what the conflict-of-interest refusal reads. */
async function overrideHead(reviewId: number, actorId: number) {
    const head = await prisma.trustedAdultReview.findUnique({
        where: { id: reviewId },
        include: { trustedAdult: { select: CONFLICT_TA_SELECT } },
    });
    if (!head) throw new TrustedAdultError("not_found", "Review not found.");
    await refuseConflictedActor(actorId, reviewId, head, OVERRIDE_CONFLICT_MESSAGE);
    return head;
}

/**
 * Board / sysadmin revoke, in any phase, under the parent lock. It ends every approval on
 * the adult, because the review the board is looking at may be a declined change sitting on
 * top of an approval. It cannot be undone. No role is exempt from the conflict-of-interest rule.
 */
export async function revokeReview(reviewId: number, actorId: number) {
    const head = await overrideHead(reviewId, actorId);
    const actor = personActor(actorId);
    const updated = await conflictCheckedTransaction(async (tx) => {
        await lockAndRecheckConflict(tx, head.trustedAdultId, actorId, reviewId, OVERRIDE_CONFLICT_MESSAGE);
        const review = await tx.trustedAdultReview.findUnique({ where: { id: reviewId } });
        if (!review) throw new TrustedAdultError("not_found", "Review not found.");

        // Retired approvals go too, so a later renewal cannot date itself from one.
        const others = await tx.trustedAdultReview.findMany({
            where: { trustedAdultId: review.trustedAdultId, status: { in: ["APPROVED", "SUPERSEDED"] }, id: { not: reviewId } },
            select: { id: true, status: true },
            orderBy: { id: "asc" },
        });
        const settled = review.status === "REVOKED";
        if (settled && others.length === 0) {
            throw new TrustedAdultError("wrong_phase", "This review has already been settled — reload the page.");
        }
        if (others.length) {
            await tx.trustedAdultReview.updateMany({ where: { id: { in: others.map((r) => r.id) } }, data: { status: "REVOKED" } });
            for (const r of others) {
                await audit(tx, actor, review.trustedAdultId, { status: r.status, reviewId: r.id }, { status: "REVOKED", reviewId: r.id, override: "revoke", overrideOf: reviewId });
            }
        }
        if (settled) return review;
        const closed = await tx.trustedAdultReview.update({
            where: { id: reviewId },
            data: { decidedById: actorId, status: "REVOKED" },
        });
        await audit(tx, actor, review.trustedAdultId, { status: review.status }, { status: "REVOKED", override: "revoke" });
        return closed;
    });
    const name = head.trustedAdult.trustedAdultName?.trim() || "your trusted adult";
    await notifyHouseholdFamily(
        head.trustedAdult.householdId,
        "trustedAdult.overrideDecided",
        { adultName: name, action: "revoked", actionLink: trustedAdultsUrl() },
    );
    return updated;
}

/**
 * Board / sysadmin reset, with a written reason: undoes the decision on the adult's latest
 * review, which then waits for a board decision through decideReview. It reaches an approval
 * still in force and a denial; the cleared decision lives on only in the audit row.
 *
 * It refuses a revoked review, a lapsed approval (the family renews it), an approved change
 * (its edits are already on the adult), a denied household, and a review that is no longer
 * the latest. The family is not emailed: the decision that follows sends its own notice.
 */
export async function resetReview(reviewId: number, actorId: number, reason: string) {
    if (!reason?.trim()) throw new TrustedAdultError("bad_input", "Give a reason for the reset.");
    const head = await overrideHead(reviewId, actorId);

    const reset = await conflictCheckedTransaction(async (tx) => {
        await lockAndRecheckConflict(tx, head.trustedAdultId, actorId, reviewId, OVERRIDE_CONFLICT_MESSAGE);
        const review = await tx.trustedAdultReview.findUnique({ where: { id: reviewId } });
        if (!review) throw new TrustedAdultError("not_found", "Review not found.");
        const latest = await tx.trustedAdultReview.findFirst({ where: { trustedAdultId: review.trustedAdultId }, orderBy: { id: "desc" } });
        if (latest?.id !== review.id) {
            throw new TrustedAdultError("wrong_phase", "This review is out of date — reload the page.");
        }
        if (review.status === "REVOKED") {
            throw new TrustedAdultError("wrong_phase", "This trusted adult was withdrawn or revoked — the household has to resubmit them.");
        }
        // A lapsed approval counts as expired before the sweep flips it.
        if (review.status === "EXPIRED" || (review.status === "APPROVED" && !isAuthorizedApproval(review, new Date()))) {
            throw new TrustedAdultError("wrong_phase", "This approval has expired — the family renews it, and the renewal comes to the Board as a new review.");
        }
        if (review.status !== "APPROVED" && review.status !== "DENIED") {
            throw new TrustedAdultError("wrong_phase", "Only an approved or denied review can be reset.");
        }
        if (review.status === "APPROVED" && review.proposedName != null) {
            throw new TrustedAdultError("wrong_phase", "This approved change is already on the trusted adult, so it can't be reset. Revoke the approval and the family resubmits.");
        }
        if (await adultHouseholdDenied(tx, head.trustedAdult)) {
            throw new TrustedAdultError("wrong_phase", "This household has been denied membership, so its trusted-adult review cannot be reset.");
        }
        if (review.status === "APPROVED") await restoreSupersededBy(tx, personActor(actorId), review.trustedAdultId, reviewId);
        const updated = await tx.trustedAdultReview.update({
            where: { id: reviewId },
            data: {
                status: "PENDING_BOARD_REVIEW",
                decision: null,
                decidedById: null,
                decisionNote: null,
                sharedNote: null,
                effectiveFrom: null,
                reviewBy: null,
                expiryWarningSentAt: null,
            },
        });
        await audit(
            tx,
            personActor(actorId),
            review.trustedAdultId,
            {
                reviewId,
                status: review.status,
                decision: review.decision,
                decidedById: review.decidedById,
                decisionNote: review.decisionNote,
                sharedNote: review.sharedNote,
                effectiveFrom: review.effectiveFrom,
                reviewBy: review.reviewBy,
                expiryWarningSentAt: review.expiryWarningSentAt,
            },
            { reviewId, status: "PENDING_BOARD_REVIEW", override: "reset", reason: reason.trim() },
        );
        return updated;
    });
    await notifyBoard();
    return reset;
}

/**
 * Nightly sweep: (1) warn the household 30 days before an approval lapses, once;
 * (2) flip approvals whose reviewBy has passed to EXPIRED so they re-enter the board
 * queue via a renewal, and tell the family. The pickup list already dropped them when
 * reviewBy passed; this run only cleans up and notifies.
 */
export async function runExpirySweep(now: Date) {
    const warnThreshold = daysFromNow(now, WARN_LEAD_DAYS);

    // "Expiring" is per adult, not per review: an adult who renewed early carries a
    // stale APPROVED row inside the window plus a live renewal that outlives it. Scope
    // to adults with a candidate row, load ALL their approvals, and let expiringApprovals
    // collapse each to its current authorization (latest reviewBy) — the stale row drops
    // out because the renewal now outlives it. Skip rows already warned once.
    const candidateAdultIds = [
        ...new Set(
            (
                await prisma.trustedAdultReview.findMany({
                    // An archived household gets no expiry warning.
                    where: { status: "APPROVED", reviewBy: { not: null, lte: warnThreshold, gt: now }, trustedAdult: { household: { archivedAt: null } } },
                    select: { trustedAdultId: true },
                })
            ).map((r) => r.trustedAdultId),
        ),
    ];
    const approvals = candidateAdultIds.length
        ? await prisma.trustedAdultReview.findMany({
              where: { trustedAdultId: { in: candidateAdultIds }, status: "APPROVED", reviewBy: { not: null } },
              select: { id: true, trustedAdultId: true, householdId: true, reviewBy: true, expiryWarningSentAt: true },
              orderBy: { id: "asc" },
          })
        : [];
    const expiring = expiringApprovals(approvals, now, warnThreshold).filter((r) => r.expiryWarningSentAt === null);
    let warned = 0;
    for (const r of expiring) {
        const due = r.reviewBy ? r.reviewBy.toISOString().slice(0, 10) : "soon";
        await notifyHouseholdFamily(
            r.householdId,
            "trustedAdult.expiring",
            { deadline: due, actionLink: trustedAdultsUrl() },
        );
        await prisma.trustedAdultReview.update({ where: { id: r.id }, data: { expiryWarningSentAt: now } });
        warned++;
    }

    const lapsed = await prisma.trustedAdultReview.findMany({
        where: { status: "APPROVED", reviewBy: { not: null, lte: now } },
        select: { id: true, trustedAdultId: true, status: true, householdId: true, trustedAdult: { select: { trustedAdultName: true, household: { select: { id: true } } } } },
    });
    let expired = 0;
    for (const r of lapsed) {
        // The read above is unlocked: a denial, withdrawal or renewal may have settled this row since.
        const flipped = await prisma.$transaction(async (tx) => {
            await lockTrustedAdult(tx, r.trustedAdultId);
            const { count } = await tx.trustedAdultReview.updateMany({
                where: { id: r.id, status: "APPROVED", reviewBy: { lte: now } },
                data: { status: "EXPIRED" },
            });
            if (count === 0) return false;
            await audit(tx, systemActor("cron:trusted-adult-expiry"), r.trustedAdultId, { status: r.status }, { status: "EXPIRED" });
            return true;
        });
        if (!flipped) continue;
        expired++;
        // Notify only after the flip commits: the status change is the authoritative act,
        // the email a courtesy on top, so a slow or failing provider can't hold the tx.
        // The flip is its own dedup — an EXPIRED row is no longer selected by this query —
        // and it also excludes this row from the authorization check below.
        const approvalLeft = await prisma.trustedAdultReview.findFirst({
            where: { trustedAdultId: r.trustedAdultId, status: "APPROVED" },
            select: { id: true },
        });
        // One lapsed review is not a lapsed adult: another approval may still authorize
        // them, or be lapsed too and flip later in this run. Only the flip that leaves the
        // adult with no approval at all earns the de-authorization notice, so it goes once.
        // Row security returns an archived household as null: it still lapses, but gets no email.
        if (approvalLeft || !r.trustedAdult.household) continue;
        const name = r.trustedAdult.trustedAdultName?.trim() || "your trusted adult";
        await notifyHouseholdFamily(
            r.householdId,
            "trustedAdult.expired",
            { adultName: name, actionLink: trustedAdultsUrl() },
        );
    }

    return { warned, expired };
}

/** Actor must be a lead of the given household, and the household not archived. */
export async function assertHouseholdLead(householdId: number, actorId: number) {
    const lead = await prisma.person.findFirst({
        where: { id: actorId, ...householdLeadsWhere(householdId) },
        select: { id: true },
    });
    if (!lead) throw new TrustedAdultError("forbidden", "You must be a lead of this household.");
    if (!(await isLiveHousehold(householdId))) throw new TrustedAdultError("wrong_phase", ARCHIVED_HOUSEHOLD_REFUSAL);
}

/** Email every board member that a trusted-adult review is waiting. */
async function notifyBoard(): Promise<void> {
    await emailBoardMembers(
        "trustedAdult.boardReview",
        { actionLink: `${config.baseUrl()}/safety/trusted-adults` },
        "Board trusted-adult ping failed:",
    );
}

/** Email the household's leads (the "family"). */
async function notifyHouseholdFamily<K extends TemplateKey>(householdId: number, key: K, ctx: TemplateCtx<K>): Promise<void> {
    await emailHouseholdLeads(householdId, key, ctx, "Family trusted-adult ping failed:");
}

function trustedAdultsUrl(): string {
    return `${config.baseUrl()}/trusted-adults`;
}

function audit(
    db: TxClient | typeof prisma,
    actor: AuditActor,
    taId: number,
    oldData: object,
    newData: object,
    action: "CREATE" | "EDIT" = "EDIT",
) {
    return db.auditLog.create({
        data: {
            ...actor,
            action,
            tableName: "TrustedAdult",
            affectedEntityId: taId,
            oldData,
            newData,
        },
    });
}
