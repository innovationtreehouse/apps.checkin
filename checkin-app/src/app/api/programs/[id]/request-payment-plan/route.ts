import { NextResponse } from "next/server";
import { orgToday } from "@/lib/appSettings";
import { logger } from "@/lib/logger";
import { withAuth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { apiError } from "@/lib/api-response";
import { isComponentHttpError, parseId } from "@checkin/component-kit";
import { isKnownAdult } from "@/lib/programAge";
import { changeProgramStockWith, StockNotRecordedError } from "@/lib/shopify/stock";
import { ENROLLMENT_WRITES } from "@/lib/programs/enrollmentState";
import { ScholarshipRequestKind } from "@/generated/prisma/client";
import { scholarshipRequestKindLabel } from "@/lib/scholarshipRequestKind";
import { resolveScholarshipRecipients, notifyReviewTeam, sendScholarshipAck } from "@/lib/scholarshipEmails";
import { config } from "@/lib/config";
import { hasHouseholdConflict } from "@/lib/conflictOfInterest";
import { householdLeadsWhere } from "@/lib/household/leads";
import { householdMayEnrol, NO_EMERGENCY_CONTACT_TO_ENROL } from "@/lib/emergencyContacts/service";
import { parseParticipantId, readObjectBody } from "@/app/api/programs/[id]/requestBody";

function isScholarshipRequestKind(value: unknown): value is ScholarshipRequestKind {
    return Object.values<unknown>(ScholarshipRequestKind).includes(value);
}

export const POST = withAuth({}, async (req, auth, { params }: { params: Promise<{ id: string }> }) => {
    if (auth.type !== 'session') return apiError("Unauthorized", 401);
    const { id } = await params;

    try {
        const programId = parseId(id, "program ID");

        const body = await readObjectBody(req);
        if (!body.participantId) {
            return apiError("participantId is required", 400);
        }
        const participantId = parseParticipantId(body.participantId);
        const kind = body.kind ?? null;

        // An absent kind records as null rather than 400: during a rolling deploy's
        // drain window a stale tab still POSTs without one, and losing the request
        // is worse than not knowing which ask it was. A present-but-wrong kind is
        // still a client bug, so that does fail.
        if (kind !== null && !isScholarshipRequestKind(kind)) {
            return apiError("kind must be SCHOLARSHIP, PAYMENT_PLAN or UNSURE", 400);
        }
        // Spread, not a plain value: writing `null` would let a kind-less hold-failed
        // retry erase a kind the family already stated. A retry that carries one overwrites.
        const kindData = kind ? { scholarshipRequestKind: kind } : {};

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

        const leadRecord = !isSelf && !isSysAdminOrBoard && participant.person?.householdId
            ? await prisma.person.findFirst({
                where: { id: currentUserId, ...householdLeadsWhere(participant.person.householdId) },
                select: { dateOfBirth: true, isDeclaredAdult: true }
            })
            : null;

        if (!isSelf && !isSysAdminOrBoard && !leadRecord) {
            return apiError("Forbidden: Not authorized to request a payment plan for this participant", 403);
        }

        // Same rule as the enroll route's lead path: only a known adult lead takes on a payment.
        const today = await orgToday();
        if (leadRecord && !isKnownAdult(leadRecord, today)) {
            return apiError(leadRecord.dateOfBirth
                ? "A household lead under 18 can't request a payment plan."
                : "Add your date of birth (or confirm you are over 25) before requesting a payment plan.", 403);
        }

        // A scholarship request IS a payment situation, so it is not a youth's to
        // make about themselves — a household lead does it. Same known-adult rule
        // as the enroll route.
        if (isSelf && !isKnownAdult({
            dateOfBirth: participant.person?.dateOfBirth ?? null,
            isDeclaredAdult: participant.person?.isDeclaredAdult,
        }, today)) {
            return apiError("A household lead must request a payment plan for a participant under 18.", 403);
        }

        if (participant.status !== 'PENDING') {
            return apiError("This enrollment is not awaiting payment", 409);
        }

        // A denied request is not sent again: the family keeps the place and may still pay,
        // and follows up with finance. The requestFlag CAS also refuses a denied row, so a
        // denial that lands after this read is kept.
        if (participant.paymentPlanDeniedAt) {
            return apiError(await deniedRequestMessage(), 409);
        }

        const householdId = participant.person?.householdId;
        const isExternalAdmin = isSysAdminOrBoard && !isSelf && !(await hasHouseholdConflict(prisma, currentUserId, householdId));
        if (!isExternalAdmin && !(await householdMayEnrol(prisma, householdId))) {
            return apiError(NO_EMERGENCY_CONTACT_TO_ENROL, 400);
        }

        // Hold ledger: APPLICATION takes a seat out of Shopify's pool (-1), stamping
        // inventoryHeldAt so every later release path (withdrawal / payment) or approval
        // knows there's a hold to account for. The -1 fires only when inventoryHeldAt goes
        // null -> now; a re-POST on a row already holding writes nothing.
        // Both stamps are compare-and-set on status: 'PENDING' (matching
        // approve/refuse) — the findUnique status read above is stale by write
        // time, and without this a concurrent approval (ACTIVE, hold consumed
        // to null) would match takeHold, re-stamp the hold, fire a second -1,
        // and reopen a resolved scholarship.
        // The request flag's false→true flip is the transition, claimed by one CAS so a
        // double-submit notifies once: the loser sees the flag already set and matches 0.
        // The flip, the hold stamp and the -1 commit in one transaction: a Board approval
        // never sees the request flag without its hold, and the -1 is owed the moment the hold is.
        const outcome = { flipped: 0, held: 0 };
        let warning: string | undefined;
        try {
            await changeProgramStockWith(participant.program, "scholarship-hold", async (tx) => {
                outcome.flipped = (await tx.programParticipant.updateMany({
                    where: { programId, personId: participantId, ...ENROLLMENT_WRITES.requestFlag.where },
                    data: ENROLLMENT_WRITES.requestFlag.data(),
                })).count;
                outcome.held = (await tx.programParticipant.updateMany({
                    where: { programId, personId: participantId, ...ENROLLMENT_WRITES.takeHold.where },
                    data: { ...ENROLLMENT_WRITES.takeHold.data(new Date()), ...kindData },
                })).count;
                return { result: null, delta: outcome.held > 0 ? -1 : 0 };
            }, { inRequest: true });
        } catch (error) {
            // Only a failed -1 falls back; any other error is a 500.
            if (!(error instanceof StockNotRecordedError)) throw error;
            outcome.held = 0;
            // The -1 could not be recorded (the stock writer has alerted the board), so neither
            // was the hold. A fresh request stands without one: PENDING_HOLD_FAILED
            // { status: PENDING, inventoryHeldAt: null, isPaymentPlanRequested: true,
            // paymentPlanDeniedAt: null } — a legitimate state, NOT a bug: the board finishes
            // placing the hold (Shopify Hold Reconciliation queue → Confirm manual hold), and
            // the 7-day non-payment sweep (which filters isPaymentPlanRequested:false) never
            // auto-kicks it. inventoryHeldAt: null keeps a held row (denied or not) untouched.
            outcome.flipped = (await prisma.programParticipant.updateMany({
                where: { programId, personId: participantId, ...ENROLLMENT_WRITES.requestWithoutHold.where },
                data: { ...ENROLLMENT_WRITES.requestWithoutHold.data(), ...kindData },
            })).count;
            // A hold-failed retry: the request is already recorded; a stated kind still overwrites.
            const retried = outcome.flipped > 0 || (await prisma.programParticipant.updateMany({
                where: { programId, personId: participantId, ...ENROLLMENT_WRITES.retryWithoutHold.where },
                data: { ...ENROLLMENT_WRITES.retryWithoutHold.data(), ...kindData },
            })).count > 0;
            if (retried) {
                // Applicant-facing: never tell them to retry — the request is
                // recorded and the board finalizes it. Nothing is required of them.
                warning = "Your scholarship / payment-plan request has been recorded and the board notified. A seat-reservation step needs a board member to finish it — nothing more is required from you.";
            } else {
                // A concurrent request placed the hold after this one's -1 failed: that request recorded it, and its kind stands.
                const row = await prisma.programParticipant.findUnique({
                    where: { programId_personId: { programId, personId: participantId } },
                    select: { status: true, isPaymentPlanRequested: true, inventoryHeldAt: true },
                });
                if (!(row?.status === 'PENDING' && row.isPaymentPlanRequested && row.inventoryHeldAt)) throw error;
            }
        }
        // Keyed on the flip: true for a fresh hold or a recorded hold-failed request, false for a
        // hold-failed retry whose request was already recorded and for the losing half of a double-submit.
        const transitioned = outcome.flipped > 0 && (outcome.held > 0 || warning !== undefined);

        // Nothing matched: a denial may have committed after the read above.
        if (outcome.flipped === 0 && outcome.held === 0 && warning === undefined) {
            const current = await prisma.programParticipant.findUnique({
                where: { programId_personId: { programId, personId: participantId } },
                select: { paymentPlanDeniedAt: true },
            });
            if (current?.paymentPlanDeniedAt) return apiError(await deniedRequestMessage(), 409);
        }

        if (transitioned) {
            const base = config.baseUrl();
            const personName = participant.person?.name || 'A household member';
            const programName = participant.program?.name || 'a program';
            await notifyReviewTeam(
                "scholarship.programReview",
                { personName, programName, requestKind: scholarshipRequestKindLabel(kind), actionLink: `${base}/finance-ops/payment-plan` },
                "Scholarship review-team notify failed (program request):",
            );
            // A participant with no household can't have leads to ack — skip the
            // ack, review-team notify above still fired.
            if (participant.person?.householdId) {
                const recipients = await resolveScholarshipRecipients(participant.person.householdId, participantId);
                if (warning) await sendScholarshipAck(recipients, "scholarship.ackProgramHoldFailed", {});
                else await sendScholarshipAck(recipients, "scholarship.ackProgram", { programName });
            }
        }

        // Deliberately no raw ProgramParticipant echo: non-board callers (self /
        // household lead) must not read the hardship fields (paymentPlanDeniedAt,
        // inventoryHeldAt) off this response.
        const responseObj: Record<string, unknown> = { success: true };
        if (warning) responseObj.warning = warning;
        return NextResponse.json(responseObj);
    } catch (error) {
        if (isComponentHttpError(error)) {
            return apiError(error.message, error.status);
        }
        logger.error("Payment plan request error:", error);
        return apiError("Failed to request payment plan", 500);
    }
});

/** The refusal for a denied request: where the family follows up, never an invented address. */
async function deniedRequestMessage(): Promise<string> {
    const settings = await prisma.boardSettings.findUnique({ where: { id: 1 }, select: { financeContactEmail: true } });
    const financeEmail = settings?.financeContactEmail?.trim();
    const followUp = financeEmail ? `please email finance at ${financeEmail}` : "please contact the Board";
    return `The scholarship or payment-plan request was not approved, so it can't be sent again. You can still pay for the place. To follow up, ${followUp}.`;
}
