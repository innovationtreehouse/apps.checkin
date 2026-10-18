import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { withAuth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { apiError } from "@/lib/api-response";
import { isKnownAdult } from "@/lib/programAge";
import { changeProgramStockWith } from "@/lib/shopify/stock";
import type { TxClient } from "@/lib/db-client";
import { fromWhere } from "@/lib/programs/enrollmentState";
import { ScholarshipRequestKind } from "@/generated/prisma/client";
import { scholarshipRequestKindLabel } from "@/lib/scholarshipRequestKind";
import { resolveScholarshipRecipients, notifyReviewTeam, sendScholarshipAck, resolveAckCopy } from "@/lib/scholarshipEmails";
import { config } from "@/lib/config";
import { escapeHtml } from "@/lib/email-templates/base";

export const POST = withAuth({}, async (req, auth, { params }: { params: Promise<{ id: string }> }) => {
    if (auth.type !== 'session') return apiError("Unauthorized", 401);
    const { id } = await params;

    try {
        const programId = parseInt(id, 10);
        if (isNaN(programId)) {
            return apiError("Invalid program ID", 400);
        }

        const body = await req.json();
        const { participantId, kind } = body;

        if (!participantId) {
            return apiError("participantId is required", 400);
        }

        // An absent kind records as null rather than 400: during a rolling deploy's
        // drain window a stale tab still POSTs without one, and losing the request
        // is worse than not knowing which ask it was. A present-but-wrong kind is
        // still a client bug, so that does fail.
        if (kind !== undefined && kind !== null && !Object.values(ScholarshipRequestKind).includes(kind)) {
            return apiError("kind must be SCHOLARSHIP, PAYMENT_PLAN or UNSURE", 400);
        }
        // Spread, not a plain value: writing `null` would let a kind-less re-POST
        // erase a kind the family already stated, and branch 2's where-clause also
        // matches an idempotent no-op re-POST. A re-request that DOES carry one
        // overwrites, which is how a family corrects a misclick after a denial.
        const kindData = kind ? { scholarshipRequestKind: kind as ScholarshipRequestKind } : {};

        const participant = await prisma.programParticipant.findUnique({
            where: {
                programId_personId: {
                    programId,
                    personId: participantId
                }
            },
            include: { person: true, program: true }
        });

        if (!participant) {
            return apiError("Participant not found in program", 404);
        }

        // Authorization: only the participant themselves, a lead of their household,
        // or a isSysadmin/board member may request a payment plan for this enrollment.
        // Without this gate any authenticated user could flip isPaymentPlanRequested
        // on an arbitrary participant's enrollment (IDOR). Deliberately NOT the
        // program's lead mentor: scholarship requested/denied is board/finance-
        // confidential, and a program volunteer should neither initiate it nor
        // observe the hardship fields.
        const currentUserId = auth.user.id;
        const isSelf = currentUserId === participantId;
        const isSysAdminOrBoard = auth.user.isSysadmin || auth.user.isBoardMember;

        let isHouseholdLead = false;
        if (!isSelf && !isSysAdminOrBoard && participant.person?.householdId) {
            const leadRecord = await prisma.person.findFirst({
                where: {
                    id: currentUserId,
                    householdId: participant.person.householdId,
                    isHouseholdLead: true
                },
                select: { id: true }
            });
            isHouseholdLead = !!leadRecord;
        }

        if (!isSelf && !isSysAdminOrBoard && !isHouseholdLead) {
            return apiError("Forbidden: Not authorized to request a payment plan for this participant", 403);
        }

        // A scholarship request IS a payment situation, so it is not a youth's to
        // make about themselves — a household lead does it. Same known-adult rule
        // as the enroll route (docs/rules/programs.md).
        if (isSelf && !isKnownAdult({
            dateOfBirth: participant.person?.dateOfBirth ?? null,
            isDeclaredAdult: participant.person?.isDeclaredAdult,
        })) {
            return apiError("A household lead must request a payment plan for a participant under 18.", 403);
        }

        if (participant.status !== 'PENDING') {
            return apiError("This enrollment is not awaiting payment", 409);
        }

        // Hold-ledger (product decision 2026-07-06): APPLICATION takes a seat out
        // of Shopify's pool (-1), stamping inventoryHeldAt so every later release
        // path (withdrawal / payment / grace-expiry) or approval knows there's a
        // hold to account for. Guard is on inventoryHeldAt, NOT isPaymentPlanRequested:
        // a denied re-applicant still holds the seat (refuse no longer releases
        // it — see the refuse route), so re-applying must NOT decrement twice.
        // Branch 1 (inventoryHeldAt null -> now): the seat is genuinely free —
        // fires -1. Branch 2 (inventoryHeldAt already set): re-application while
        // holding (or an idempotent re-POST) — just (re)flips the request flag
        // and clears any denial stamp, no second decrement.
        // Both stamps are compare-and-set on status: 'PENDING' (matching
        // approve/refuse) — the findUnique status read above is stale by write
        // time, and without this a concurrent approval (ACTIVE, hold consumed
        // to null) would match branch 1, re-stamp the hold, fire a second -1,
        // and reopen a resolved scholarship.
        // The request flag's false→true flip is the transition, claimed by one CAS so a
        // double-submit notifies once: the loser sees the flag already set and matches 0.
        // The flip, the hold stamp and the -1 commit in one transaction: a Board approval
        // never sees the request flag without its hold, and the -1 is owed the moment the hold is.
        const writes = async (tx: TxClient, stamp: boolean) => {
            const flipped = await tx.programParticipant.updateMany({
                // From PENDING_UNPAID or PENDING_HELD_DENIED; their status clause is shared.
                where: { programId, personId: participantId, ...fromWhere('PENDING_UNPAID'), isPaymentPlanRequested: false },
                data: { isPaymentPlanRequested: true },
            });
            if (!stamp) return { flipped: flipped.count, held: 0, re: 0 };
            const holdResult = await tx.programParticipant.updateMany({
                // T3 apply CAS from-state (PENDING_UNPAID); flag narrowing stays literal (#1080).
                where: { programId, personId: participantId, ...fromWhere('PENDING_UNPAID'), inventoryHeldAt: null },
                data: { isPaymentPlanRequested: true, inventoryHeldAt: new Date(), paymentPlanDeniedAt: null, ...kindData },
            });
            let re = 0;
            if (holdResult.count === 0) {
                re = (await tx.programParticipant.updateMany({
                    // T3 re-apply CAS from-state (PENDING_HELD_DENIED); status clause shared with UNPAID.
                    where: { programId, personId: participantId, ...fromWhere('PENDING_HELD_DENIED'), inventoryHeldAt: { not: null } },
                    data: { isPaymentPlanRequested: true, paymentPlanDeniedAt: null, ...kindData },
                })).count;
            }
            return { flipped: flipped.count, held: holdResult.count, re };
        };

        let outcome: { flipped: number; held: number; re: number };
        let warning: string | undefined;
        try {
            outcome = (await changeProgramStockWith(participant.program, "scholarship-hold", async (tx) => {
                const result = await writes(tx, true);
                return { result, delta: result.held > 0 ? -1 : 0 };
            }, { inRequest: true })).result;
        } catch {
            // The -1 could not be recorded (the stock writer has alerted the board), so
            // neither was the hold. The request stands without one: PENDING_HOLD_FAILED { status: PENDING, inventoryHeldAt: null,
            // isPaymentPlanRequested: true, paymentPlanDeniedAt: null } — a legitimate
            // state, NOT a bug: the board finishes placing the hold (Shopify Hold
            // Reconciliation queue → Confirm manual hold), and the 7-day non-payment
            // sweep (which filters isPaymentPlanRequested:false) never auto-kicks it.
            outcome = await writes(prisma, false);
            // Applicant-facing: never tell them to retry — the request is
            // recorded and the board finalizes it. Nothing is required of them.
            warning = "Your scholarship / payment-plan request has been recorded and the board notified. A seat-reservation step needs a board member to finish it — nothing more is required from you.";
        }
        // fromWhere only narrows on `status` (PENDING) — both branches' where also match an
        // already-PENDING_HELD no-op re-POST, so a bare count>0 check would over-notify. Key
        // on the flip instead: true for exactly the two real transitions (fresh hold, re-request
        // after denial), false for both non-transitions (no-op re-POST, hold-failed retry whose
        // request was already recorded) and for the losing half of a double-submit.
        const transitioned = outcome.flipped > 0 && (outcome.held > 0 || outcome.re > 0 || warning !== undefined);

        if (transitioned) {
            const base = config.baseUrl();
            const personName = participant.person?.name || 'A household member';
            const programName = participant.program?.name || 'a program';
            await notifyReviewTeam(
                `New scholarship / payment-plan request: ${personName} — ${programName}`,
                `<p>The Scholarship Review Team has a new request to review.</p>`
                + `<p><strong>${escapeHtml(personName)}</strong> requested a scholarship / payment plan for <strong>${escapeHtml(programName)}</strong>.</p>`
                + `<p>What they asked for: <strong>${escapeHtml(scholarshipRequestKindLabel(kind))}</strong></p>`
                + `<p>Review it here: <a href="${base}/finance-ops/payment-plan">${base}/finance-ops/payment-plan</a></p>`,
                "Scholarship review-team notify failed (program request):",
            );
            // A participant with no household can't have leads to ack — skip the
            // ack, review-team notify above still fired.
            if (participant.person?.householdId) {
                const recipients = await resolveScholarshipRecipients(participant.person.householdId, participantId);
                const ackSettings = await prisma.boardSettings.findUnique({
                    where: { id: 1 },
                    select: { scholarshipAckSubject: true, scholarshipAckProgramBody: true },
                });
                const ack = resolveAckCopy(ackSettings, "program", { programName });
                // Shopify-failure branch: the operational-incident copy is deliberately
                // hard-coded (not configurable) — the configured subject still applies.
                const ackBody = warning ? `<p>${escapeHtml(warning)}</p>` : ack.body;
                await sendScholarshipAck(recipients, ack.subject, ackBody);
            }
        }

        // Deliberately no raw ProgramParticipant echo: non-board callers (self /
        // household lead) must not read the hardship fields (paymentPlanDeniedAt,
        // inventoryHeldAt) off this response.
        const responseObj: Record<string, unknown> = { success: true };
        if (warning) responseObj.warning = warning;
        return NextResponse.json(responseObj);
    } catch (error) {
        logger.error("Payment plan request error:", error);
        return apiError("Failed to request payment plan", 500);
    }
});
