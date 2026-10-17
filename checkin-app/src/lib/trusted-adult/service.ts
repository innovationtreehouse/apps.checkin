import prisma from "@/lib/prisma";
import { personActor, systemActor, type AuditActor } from "@/lib/auditActor";
import { escapeHtml } from "@/lib/email-templates/base";
import { emailBoardMembers, emailHouseholdLeads } from "@/lib/emailRecipients";
import { isTrustedAdultConflict } from "@/lib/trusted-adult/conflict";
import { AUTHORIZED_REVIEW, expiringApprovals } from "@/lib/trusted-adult/filters";
import { config } from "@/lib/config";
import { validateContact } from "@/lib/trusted-adult/contact";
import type { TxClient } from "@/lib/db-client";

/**
 * Serialize all mutations of one TrustedAdult by taking a row lock on the parent.
 * renew/withdraw/decide each read-check-write; without this lock two concurrent
 * calls both pass the check and both write (TOCTOU). Mirrors lib/membership/review.ts.
 */
function lockTrustedAdult(tx: TxClient, taId: number) {
    return tx.$queryRaw`SELECT id FROM "TrustedAdult" WHERE id = ${taId} FOR UPDATE`;
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
 *   APPROVED ──(reviewBy passes)──► EXPIRED ──(renew)──► new PENDING_BOARD_REVIEW
 *   any non-terminal ──(household withdraws / board override)──► REVOKED
 */

const APPROVAL_VALID_DAYS = 365;
const WARN_LEAD_DAYS = 30;

export class TrustedAdultError extends Error {
    constructor(
        public readonly code:
            | "not_found"
            | "bad_input"
            | "wrong_phase"
            | "forbidden"
            | "already_open",
        message: string,
    ) {
        super(message);
        this.name = "TrustedAdultError";
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
 * file (no re-entry). Allowed only when no review is already in flight. Callable
 * by a lead of the household.
 */
export async function renewTrustedAdult(id: number, actorId: number) {
    const ta = await prisma.trustedAdult.findUnique({ where: { id }, select: { id: true, householdId: true } });
    if (!ta) throw new TrustedAdultError("not_found", "Trusted adult not found.");
    await assertHouseholdLead(ta.householdId, actorId);

    // Lock the parent, re-read the latest review under the lock, then create. Without
    // the lock two concurrent renews both see a terminal latest and both open a review.
    const review = await prisma.$transaction(async (tx) => {
        await lockTrustedAdult(tx, ta.id);
        const latest = await tx.trustedAdultReview.findFirst({ where: { trustedAdultId: ta.id }, orderBy: { id: "desc" } });
        if (latest && (latest.status === "PENDING_BOARD_REVIEW" || latest.status === "PENDING_SUBJECT_ACTION")) {
            throw new TrustedAdultError("already_open", "A review for this trusted adult is already in progress.");
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

    const ta = await prisma.trustedAdult.findUnique({ where: { id }, select: { id: true, householdId: true } });
    if (!ta) throw new TrustedAdultError("not_found", "Trusted adult not found.");
    await assertHouseholdLead(ta.householdId, actorId);

    const review = await prisma.$transaction(async (tx) => {
        await lockTrustedAdult(tx, ta.id);
        const latest = await tx.trustedAdultReview.findFirst({ where: { trustedAdultId: ta.id }, orderBy: { id: "desc" } });
        if (latest && (latest.status === "PENDING_BOARD_REVIEW" || latest.status === "PENDING_SUBJECT_ACTION")) {
            throw new TrustedAdultError("already_open", "A review for this trusted adult is already in progress.");
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

/**
 * Promote a MODIFIED review's proposed facts onto the parent TrustedAdult. Called
 * inside the approval transaction only — the live approved facts stay put until the
 * board actually signs off on the change. No-op for INITIAL/RENEWAL reviews.
 */
function promoteProposal(
    tx: TxClient,
    review: { kind: string; trustedAdultId: number; proposedName: string | null; proposedPhone: string | null; proposedEmail: string | null; proposedContext: string | null },
) {
    if (review.kind !== "MODIFIED") return;
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
 * prior APPROVED row lingers, and the pickup list (/operational) shows a TA while
 * ANY review is APPROVED. Revoking only the latest would leave a stale approval
 * live, so the adult keeps showing up on the pickup list after withdrawal.
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
 * A board member decides a review (single entry, no quorum). Acts only on a
 * review awaiting board review.
 *   APPROVE       -> requires sharedNote; stamps effectiveFrom + reviewBy (now + 1yr)
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
        select: {
            trustedAdultId: true,
            trustedAdult: { select: { householdId: true, trustedAdultPersonId: true, trustedAdultName: true } },
        },
    });
    if (!head) throw new TrustedAdultError("not_found", "Review not found.");

    // Conflict of interest: a board member may not decide a trusted-adult review for
    // their own household, nor one where they are the counterparty. The UI disables the
    // buttons off the same rule; this is the real enforcement — a direct POST bypasses the UI.
    const me = await prisma.person.findUnique({ where: { id: boardMemberId }, select: { householdId: true } });
    if (
        isTrustedAdultConflict({
            actorParticipantId: boardMemberId,
            actorHouseholdId: me?.householdId,
            taHouseholdId: head.trustedAdult.householdId,
            taTrustedAdultPersonId: head.trustedAdult.trustedAdultPersonId,
        })
    ) {
        throw new TrustedAdultError("forbidden", "You can't decide your own household's trusted-adult review — another board member must.");
    }

    // Lock the parent TA, then re-read the review under the lock and check its phase.
    // Without this two board members both read PENDING_BOARD_REVIEW, both update, and
    // both write an audit row — the loser leaving an orphan audit that contradicts state.
    const result = await prisma.$transaction(async (tx) => {
        await lockTrustedAdult(tx, head.trustedAdultId);
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
            case "APPROVE":
                status = "APPROVED";
                data.effectiveFrom = now;
                data.reviewBy = daysFromNow(now, APPROVAL_VALID_DAYS);
                data.sharedNote = input.sharedNote!.trim();
                break;
            case "DENY":
                status = "DENIED";
                break;
            default:
                status = "PENDING_SUBJECT_ACTION";
                break;
        }
        data.status = status;

        const updated = await tx.trustedAdultReview.update({ where: { id: reviewId }, data });
        // Approving a MODIFIED review is the moment its proposed edits become fact.
        if (input.decision === "APPROVE") await promoteProposal(tx, review);
        await audit(tx, personActor(boardMemberId), review.trustedAdultId, { status: review.status }, { status, decision: input.decision });
        // "Deny & Revoke": reject the adult outright. Revoke EVERY live approval, not
        // just one — /operational shows a TA while ANY review is APPROVED, so leaving
        // one live would keep the adult on the pickup list after a full rejection.
        if (input.decision === "DENY" && input.revokePriorApprovals) {
            const live = await tx.trustedAdultReview.findMany({
                where: { trustedAdultId: review.trustedAdultId, ...AUTHORIZED_REVIEW },
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
        await notifyHouseholdFamily(result.householdId, "The board needs more information about a trusted adult", input.note?.trim());
    }
    // Every denial notifies the family. The message depends on what survives the deny:
    // a live approval left standing (a rejected change), nothing left (a plain rejection),
    // or a deliberate full revocation.
    if (input.decision === "DENY") {
        const name = head.trustedAdult.trustedAdultName?.trim() || "your trusted adult";
        if (input.revokePriorApprovals) {
            await notifyHouseholdFamily(
                result.householdId,
                `Trusted adult no longer authorized: ${name}`,
                `The board did not approve ${name}, and any prior approval has been revoked. They are no longer authorized at the front desk. You may submit a new request if things change.`,
            );
        } else {
            // Mirror /operational's rule: a surviving APPROVED review = still authorized.
            const live = await prisma.trustedAdultReview.findFirst({
                where: { trustedAdultId: head.trustedAdultId, ...AUTHORIZED_REVIEW },
                orderBy: { reviewBy: "desc" },
            });
            if (live) {
                const until = live.reviewBy ? ` (valid until ${live.reviewBy.toISOString().slice(0, 10)})` : "";
                await notifyHouseholdFamily(
                    result.householdId,
                    `Trusted adult change not approved: ${name}`,
                    `The board did not approve your recent change to ${name}. The previously approved arrangement${until} remains in effect. You can submit a new change any time.`,
                );
            } else {
                await notifyHouseholdFamily(
                    result.householdId,
                    `Trusted adult not approved: ${name}`,
                    `The board did not approve ${name}. You may submit a new request if things change.`,
                );
            }
        }
    }
    return result.updated;
}

/**
 * Board / sysadmin override: force a review to a terminal state regardless of phase.
 *
 * Same conflict-of-interest rule as decideReview, and no role is exempt from it — a
 * board member may not override their OWN household's review (else they could
 * force-approve their own trusted adult, the very thing decideReview forbids), and
 * neither may a sysadmin. Someone outside the household has to decide the case.
 */
export async function overrideReview(
    reviewId: number,
    actorId: number,
    action: "approve" | "deny" | "revoke",
    sharedNote?: string | null,
) {
    const review = await prisma.trustedAdultReview.findUnique({
        where: { id: reviewId },
        include: { trustedAdult: { select: { householdId: true, trustedAdultPersonId: true, trustedAdultName: true } } },
    });
    if (!review) throw new TrustedAdultError("not_found", "Review not found.");

    const me = await prisma.person.findUnique({ where: { id: actorId }, select: { householdId: true } });
    if (
        isTrustedAdultConflict({
            actorParticipantId: actorId,
            actorHouseholdId: me?.householdId,
            taHouseholdId: review.trustedAdult.householdId,
            taTrustedAdultPersonId: review.trustedAdult.trustedAdultPersonId,
        })
    ) {
        throw new TrustedAdultError("forbidden", "You can't override your own household's trusted-adult review — someone outside your household must.");
    }

    const now = new Date();
    const data: Record<string, unknown> = { decidedById: actorId };
    if (action === "approve") {
        if (!sharedNote?.trim()) {
            throw new TrustedAdultError("bad_input", "A shared note is required to force-approve.");
        }
        data.status = "APPROVED";
        data.decision = "APPROVE";
        data.sharedNote = sharedNote.trim();
        data.effectiveFrom = now;
        data.reviewBy = daysFromNow(now, APPROVAL_VALID_DAYS);
    } else if (action === "deny") {
        data.status = "DENIED";
        data.decision = "DENY";
    } else {
        data.status = "REVOKED";
    }

    const updated = await prisma.$transaction(async (tx) => {
        const u = await tx.trustedAdultReview.update({ where: { id: reviewId }, data });
        if (action === "approve") await promoteProposal(tx, review);
        await audit(tx, personActor(actorId), review.trustedAdultId, { status: review.status }, { status: data.status, override: action });
        return u;
    });
    // A forced denial/revocation notifies the family, like the ordinary deny path.
    if (action === "deny" || action === "revoke") {
        const name = review.trustedAdult.trustedAdultName?.trim() || "your trusted adult";
        await notifyHouseholdFamily(
            review.trustedAdult.householdId,
            `Trusted adult no longer authorized: ${name}`,
            `The board has ${action === "revoke" ? "revoked" : "denied"} ${name}. They are no longer authorized at the front desk. You may submit a new request if things change.`,
        );
    }
    return updated;
}

/**
 * Nightly sweep: (1) warn the household 30 days before an approval lapses, once;
 * (2) expire approvals whose reviewBy has passed so they re-enter the board queue
 * via a renewal, and tell the family — expiring drops the adult off the front
 * desk's pickup list, so silence would surface as a refused pickup.
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
                    where: { status: "APPROVED", reviewBy: { not: null, lte: warnThreshold, gt: now } },
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
            "A trusted adult approval is expiring soon",
            `This board-approved trusted adult expires on ${due}. You can resubmit it for board review in one click — no need to re-enter anything.`,
        );
        await prisma.trustedAdultReview.update({ where: { id: r.id }, data: { expiryWarningSentAt: now } });
        warned++;
    }

    const lapsed = await prisma.trustedAdultReview.findMany({
        where: { status: "APPROVED", reviewBy: { not: null, lte: now } },
        select: { id: true, trustedAdultId: true, status: true, householdId: true, trustedAdult: { select: { trustedAdultName: true } } },
    });
    let expired = 0;
    for (const r of lapsed) {
        await prisma.$transaction(async (tx) => {
            await tx.trustedAdultReview.update({ where: { id: r.id }, data: { status: "EXPIRED" } });
            await audit(tx, systemActor("cron:trusted-adult-expiry"), r.trustedAdultId, { status: r.status }, { status: "EXPIRED" });
        });
        expired++;
        // Notify only after the flip commits: the status change is the authoritative act,
        // the email a courtesy on top, so a slow or failing provider can't hold the tx.
        // The flip is its own dedup — an EXPIRED row is no longer selected by this query —
        // and it also excludes this row from the authorization check below.
        const stillAuthorized = await prisma.trustedAdultReview.findFirst({
            where: { trustedAdultId: r.trustedAdultId, ...AUTHORIZED_REVIEW },
            select: { id: true },
        });
        // One lapsed review is not a lapsed adult: a renewal approved before this row's
        // date still authorizes them, and /operational still lists them. Only the review
        // that leaves the adult with no approval at all earns the de-authorization notice.
        if (stillAuthorized) continue;
        const name = r.trustedAdult.trustedAdultName?.trim() || "your trusted adult";
        await notifyHouseholdFamily(
            r.householdId,
            `Trusted adult approval expired: ${name}`,
            `The board's approval of ${name} has expired. They are no longer authorized at the front desk. You can resubmit them for board review in one click — no need to re-enter anything.`,
        );
    }

    return { warned, expired };
}

/** Actor must be a lead of the given household. */
export async function assertHouseholdLead(householdId: number, actorId: number) {
    const lead = await prisma.person.findFirst({
        where: { id: actorId, householdId, isHouseholdLead: true },
        select: { id: true },
    });
    if (!lead) throw new TrustedAdultError("forbidden", "You must be a lead of this household.");
}

/** Email every board member that a trusted-adult review is waiting. */
async function notifyBoard(): Promise<void> {
    const base = config.baseUrl();
    await emailBoardMembers(
        "Trusted adult: a disclosure needs board review",
        `<p>A trusted-adult disclosure is awaiting board review. <a href="${base}/safety/trusted-adults">Review it</a>.</p>`,
        "Board trusted-adult ping failed:",
    );
}

/** Email the household's leads (the "family"). */
async function notifyHouseholdFamily(householdId: number, subject: string, body?: string): Promise<void> {
    const base = config.baseUrl();
    const html = `<p>${escapeHtml(body ?? "")}</p><p><a href="${base}/trusted-adults">View your trusted adults</a>.</p>`;
    await emailHouseholdLeads(householdId, subject, html, "Family trusted-adult ping failed:");
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
