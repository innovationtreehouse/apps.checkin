import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { withAuth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import type { TxClient } from "@/lib/db-client";
import { isPrismaError } from "@/lib/prismaUniqueViolation";
import { sendNotification } from "@/lib/notifications";
import { ENROLLMENT_WRITES } from "@/lib/programs/enrollmentState";
import { deleteAndReleaseHold, type ExitOptions, lockProgramForClaim, PROGRAM_ENDED_NO_CLAIMS, ProgramCapacityError, withdrawParticipant } from "@/lib/program/capacity";
import { checkProgramAge, isKnownAdult } from "@/lib/programAge";
import { hasHouseholdConflict, sharesHousehold } from "@/lib/conflictOfInterest";
import { householdLeadship } from "@/lib/household/leads";
import { isMembershipFeeSettled } from "@/lib/orgMembership";
import { isProgramCheckoutBroken } from "@/lib/programCheckout";
import { isProgramStoreClosed } from "@/lib/programs/storeClosed";
import { changeProgramStockWith } from "@/lib/shopify/stock";
import { isSaleEnded } from "@/lib/programs/saleState";
import { PROGRAM_ENDED_PAYMENT } from "@/lib/programs/checkoutSignature";
import { apiError } from "@/lib/api-response";
import { httpError, isComponentHttpError, parseId, readJson, ServiceError } from "@checkin/component-kit";
import { lockLiveHouseholdsOf } from "@/lib/household/archiveGuard";
import { householdMayEnrol, NO_EMERGENCY_CONTACT_TO_ENROL } from "@/lib/emergencyContacts/service";
import { personActor, recordAudit } from "@/lib/auditActor";
import { enrollByHandIn, isEnrollmentBasis, readMatchedOrder, type MatchedOrder } from "@/lib/programs/enrollByHand";

function parseParticipantId(raw: unknown): number {
    if (raw === undefined || raw === null) throw httpError(400, "participantId is required");
    if (typeof raw !== "number") throw httpError(400, "Invalid participantId");
    return parseId(String(raw), "participantId");
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readObjectBody(req: Request): Promise<Record<string, unknown>> {
    const body = await readJson(req);
    if (!isJsonObject(body)) throw httpError(400, "Invalid JSON body");
    return body;
}

export const POST = withAuth({}, async (req, auth, { params }: { params: Promise<{ id: string }> }) => {
    if (auth.type !== 'session') return apiError("Unauthorized", 401);
    const { id } = await params;

    try {
        const programId = parseId(id, "program ID");

        const body = await readObjectBody(req);
        const participantId = parseParticipantId(body.participantId);

        // A basis asks to enroll by hand: no store payment, recording what the place stands for.
        const basis = body.basis ?? null;
        if (basis !== null && !isEnrollmentBasis(basis)) {
            return apiError("basis must be OUTSIDE_PAYMENT, MATCHED_ORDER or COMP", 400);
        }
        const orderId = typeof body.shopifyOrderId === 'string' ? body.shopifyOrderId.trim() : '';
        if ((basis === 'MATCHED_ORDER') !== (orderId !== '') || (orderId && !/^\d+$/.test(orderId))) {
            return apiError("A matched store order needs its numeric order id, and only a matched order takes one.", 400);
        }
        const note = typeof body.note === 'string' ? body.note.trim() : '';

        // Capacity is counted under a row lock inside the enroll transaction
        // below, so no _count is fetched here.
        const currentProgram = await prisma.program.findUnique({
            where: { id: programId }
        });
        if (!currentProgram) {
            return apiError("Program not found", 404);
        }

        const currentUserId = auth.user.id;
        const isSelfEnrollment = currentUserId === participantId;
        const isSysAdminOrBoard = auth.user.isSysadmin || auth.user.isBoardMember;
        const isBoardOrFinance = !!(auth.user.isBoardMember || auth.user.isFinance);

        const participantData = await prisma.person.findUnique({
            where: { id: participantId },
            select: { dateOfBirth: true, isDeclaredAdult: true, householdId: true }
        });

        const leadRecord = participantData?.householdId
            ? await prisma.person.findFirst({
                where: {
                    id: currentUserId,
                    householdId: participantData.householdId,
                    isHouseholdLead: true
                },
                select: { dateOfBirth: true, isDeclaredAdult: true }
            })
            : null;

        if (!isSelfEnrollment && !isSysAdminOrBoard && !leadRecord && !(basis && isBoardOrFinance)) {
            return apiError("Forbidden: Not authorized to enroll this participant. Program leads cannot manually add participants.", 403);
        }

        // Enrolling someone takes on their payment, so a household lead acting for
        // them must be a known adult; a youth or unknown-age lead stays a lead.
        if (!isSelfEnrollment && !isSysAdminOrBoard && !basis && leadRecord && !isKnownAdult(leadRecord)) {
            return apiError(leadRecord.dateOfBirth
                ? "A household lead under 18 can't enroll a participant."
                : "Add your date of birth (or confirm you are over 25) before enrolling someone.", 403);
        }

        // Conflict of interest: an override and a hand enrollment are both one-actor
        // decisions, so neither may be spent on yourself or your own household.
        // Self is its own leg — an actor with no household is not caught by the
        // household comparison, but is still enrolling themselves. This is the
        // route's single notion of "own household"; `leadRecord` above
        // answers a different question (may you act for this person at all).
        const isConflicted = isSelfEnrollment
            || await hasHouseholdConflict(prisma, currentUserId, participantData?.householdId);

        // Only the Board or Finance, outside their own household, enroll without a store payment.
        if (basis && (!isBoardOrFinance || isConflicted)) {
            return apiError(isConflicted
                ? "This person is in your own household; someone outside it must enroll them without payment."
                : "Only the Board or Finance enroll someone without a store payment.", 403);
        }
        const order: MatchedOrder | null = basis === 'MATCHED_ORDER' ? await readMatchedOrder(orderId) : null;

        // A family that claimed in time can pay until the program ends: an existing
        // PENDING claim skips every limit below (capacity would count its own row) and
        // gets the 409 the program page folds back into its checkout. Once ended, the
        // Board settles it by hand.
        const existingClaim = await prisma.programParticipant.findUnique({
            where: { programId_personId: { programId, personId: participantId } },
            select: { status: true },
        });
        if (existingClaim?.status === 'PENDING') {
            // The claim already passed every limit; enrolling it by hand stands for a payment
            // made outside the app, so neither the off-sale date nor the program's end refuses it.
            if (basis) {
                const { result: enrollment, landed } = await changeProgramStockWith(currentProgram, "enroll-by-hand",
                    async (tx) => {
                        await lockLiveHouseholdsOf(tx, [participantId]);
                        const { row, delta } = await enrollByHandIn(tx, currentProgram, participantId, basis, order, currentUserId, note);
                        return { result: row, delta };
                    }, { inRequest: true });
                return NextResponse.json({ success: true, enrollment, ...(!landed && { warning: STOCK_WARNING }) });
            }
            if (currentProgram.phase === 'FINISHED') return apiError(PROGRAM_ENDED_PAYMENT, 400);
            return apiError("Participant is already enrolled in this program.", 409);
        }

        // Re-judged under the lock below; this answers the common case before any other check.
        if (currentProgram.phase === 'FINISHED') return apiError(PROGRAM_ENDED_NO_CLAIMS, 409);

        const override = body.override === true;

        // Staff adding from the roster are exempt, so the front desk can fix the contact afterwards.
        const isRosterStaff = (isSysAdminOrBoard || isBoardOrFinance) && !isConflicted;
        if (!isRosterStaff && !(await householdMayEnrol(prisma, participantData?.householdId))) {
            return apiError(NO_EMERGENCY_CONTACT_TO_ENROL, 400);
        }

        // ponytail: a confirmed board/isSysadmin override INTENTIONALLY bypasses
        // every soft limit — closed enrollment, members-only, age, AND capacity —
        // for OTHERS, so the board can deliberately overfill a program. This is
        // intent, not a missing guard: see the requiresOverride:true responses the
        // UI turns into a confirm button. Normal users, and any conflicted actor,
        // always hit enforceLimits=true and cannot overbook (capacity is locked
        // under FOR UPDATE in the tx below; tested in
        // programsParticipantsConcurrency.integration.test.ts and the FULL-program
        // override test in programsParticipantsAPI.integration.test.ts). Do not
        // narrow this so it also gates the non-conflicted admin path.
        const enforceLimits = !override || !isSysAdminOrBoard || isConflicted;

        // Validation Checks
        if (enforceLimits) {
            // Check Enrollment Status
            if (currentProgram.enrollmentStatus === 'CLOSED') {
                return NextResponse.json({ error: "Program enrollment is currently closed.", requiresOverride: true }, { status: 400 });
            }
            // The off-sale date closes new claims at once; the daily sweep only
            // records it. Claims made in time returned 409 above and still pay.
            if (isSaleEnded(currentProgram)) {
                return NextResponse.json({ error: "Sales for this program have ended.", requiresOverride: true }, { status: 400 });
            }

            // Members-only, judged on the PERSON being enrolled (a household lead
            // enrolling a dependent is judged on the dependent's household). This is
            // the authoritative join gate: a publiclyVisible members-only program is
            // shown to non-members, so a non-member can reach the enroll button and
            // must be refused here. Fee-settled, not ACTIVE — it admits a paid
            // household awaiting background clearance, matching the read gates.
            if (currentProgram.orgMemberOnly && !(await isMembershipFeeSettled(participantId))) {
                return NextResponse.json({ error: "This program is for Treehouse Members only.", requiresOverride: true }, { status: 400 });
            }

            // Check Age (as of program start; now for dateless programs). A declared
            // adult with no DOB is handled inside checkProgramAge — over-25 satisfies
            // a youth minimum like "16 and up".
            const ageCheck = checkProgramAge(
                { dateOfBirth: participantData?.dateOfBirth ?? null, isDeclaredAdult: participantData?.isDeclaredAdult },
                { minAge: currentProgram.minAge, maxAge: currentProgram.maxAge, asOf: currentProgram.startAt },
            );
            if (!ageCheck.ok) {
                const error = ageCheck.reason === "dob"
                    ? "Participant Date of Birth is missing."
                    : ageCheck.label === "Too young"
                        ? `Participant must be at least ${currentProgram.minAge} years old.`
                        : ageCheck.label === "Too old"
                            ? `Participant maximum age is ${currentProgram.maxAge} years old.`
                            : "Participant is outside this program's age range.";
                return NextResponse.json({ error, requiresOverride: true }, { status: 400 });
            }

            // Only a KNOWN adult may commit THEMSELVES to a program (and to its
            // Shopify charge). Everyone else needs a household lead to enroll
            // them — the guardian-consent line at 18, independent of the
            // program's own minAge/maxAge above. Unverifiable age refuses too,
            // and routes to the age capture the enroll page already offers.
            if (isSelfEnrollment && participantData && !isKnownAdult(participantData)) {
                return apiError(participantData.dateOfBirth
                    ? "A household lead must enroll a participant under 18."
                    : "Add your date of birth (or confirm you are over 25) before enrolling yourself.", 403);
            }
        }

        // Zero is free, same as unpriced: variants are minted only above zero
        // (api/programs POST), so a zero-priced program has nothing to charge
        // through and must not wait on a payment.
        const isFree = (currentProgram.orgMemberPriceCents ?? 0) === 0 && (currentProgram.nonOrgMemberPriceCents ?? 0) === 0;
        if (basis && isFree) {
            return apiError("A free program takes no payment, so enroll without saying what it stands for.", 400);
        }

        // PENDING (awaits payment) unless the program is free. A hand enrollment
        // writes the claim and activates it in the same transaction. A board parent
        // overriding a soft limit for their own household still pays — the override
        // bypasses limits, not the fee.
        const initialStatus = isFree ? 'ACTIVE' : 'PENDING';

        // Fail closed on a priced-but-unsellable program: PENDING means "awaits a
        // Shopify payment", and a priced program with no variant has nothing to
        // pay through — the seat would sit PENDING forever. A hand enrollment needs
        // no store payment, so it still goes through.
        // No requiresOverride: an override cannot make the program sellable.
        if (initialStatus === 'PENDING' && !basis && isProgramCheckoutBroken(currentProgram, await isProgramStoreClosed())) {
            return apiError("This program has a price but no payment link set up, so enrollment can't be paid for. An admin must fix the Shopify link in program-ops before anyone can enroll.", 400);
        }

        // A hand enrollment's row, its stamp and its stock change commit in one transaction,
        // so a crash leaves all or none. What a crash can still leave is a recorded change
        // not yet pushed; it stays owed in the carry and the daily heal lands it.
        const byHand = (tx: TxClient) => basis && initialStatus === 'PENDING'
            ? enrollByHandIn(tx, currentProgram, participantId, basis, order, currentUserId, note)
            : null;
        const { result: enrollment, landed: stockLanded } = await changeProgramStockWith(currentProgram, "enroll", async (tx) => {
            await lockLiveHouseholdsOf(tx, [participantId]);
            // Phase and capacity are judged under the row lock right before insert, so neither
            // a concurrent end, a cap cut nor another enroller can be raced past.
            await lockProgramForClaim(tx, programId, 1, enforceLimits);
            if (existingClaim?.status !== 'WITHDRAWN') {
                const row = await tx.programParticipant.create({
                    data: {
                        programId,
                        personId: participantId,
                        status: initialStatus,
                    }
                });
                await recordAudit(tx, personActor(currentUserId), {
                    action: 'CREATE',
                    tableName: 'ProgramParticipant',
                    affectedEntityId: participantId,
                    secondaryAffectedEntity: programId,
                    newData: row
                });
                const hand = await byHand(tx);
                return hand ? { result: hand.row, delta: hand.delta } : { result: row, delta: 0 };
            }
            // One row per (person, program): re-enrolment reactivates the withdrawn
            // row and clears the last stint's fields, so its order, plan request and
            // clocks never join the new stint.
            const reenroll = initialStatus === 'ACTIVE' ? ENROLLMENT_WRITES.reenrollComp : ENROLLMENT_WRITES.reenrollPaid;
            const { count } = await tx.programParticipant.updateMany({
                where: { programId, personId: participantId, ...reenroll.where },
                data: {
                    ...reenroll.data(),
                    endedAt: null,
                    pendingSince: new Date(),
                    scholarshipRequestKind: null,
                    wasOrgMemberAtApproval: null,
                    shopifyOrderId: null,
                    seatTakenWithoutSaleAt: null,
                    enrollmentBasis: null,
                },
            });
            if (count === 0) return { result: null, delta: 0 };
            const row = await tx.programParticipant.findUniqueOrThrow({ where: { programId_personId: { programId, personId: participantId } } });
            await recordAudit(tx, personActor(currentUserId), {
                action: 'EDIT',
                tableName: 'ProgramParticipant',
                affectedEntityId: participantId,
                secondaryAffectedEntity: programId,
                newData: row
            });
            const hand = await byHand(tx);
            return hand ? { result: hand.row, delta: hand.delta } : { result: row, delta: 0 };
        }, { inRequest: true });
        if (!enrollment) {
            return apiError("Participant is already enrolled in this program.", 409);
        }

        // Trigger notification
        await sendNotification(participantId, 'PROGRAM_ENROLLMENT', { programName: currentProgram.name });

        // The stock writer has already logged and emailed the board when a push failed.
        let warning: string | undefined;
        if (basis && !stockLanded) warning = STOCK_WARNING;

        const responseObj: Record<string, unknown> = { success: true, enrollment };
        if (warning) responseObj.warning = warning;
        return NextResponse.json(responseObj);
    } catch (error) {
        if (isComponentHttpError(error)) {
            return apiError(error.message, error.status);
        }
        if (error instanceof ProgramCapacityError) {
            return NextResponse.json({ error: "Program has reached maximum capacity.", requiresOverride: true }, { status: 400 });
        }
        if (error instanceof ServiceError) {
            return apiError(error.message, error.status);
        }
        // P2002 = unique violation on the @@id([programId, participantId]) PK.
        // Benign double-submit (UI double-click) re-enrolls the same participant;
        // return 409 instead of a 500.
        if (isPrismaError(error, 'P2002')) {
            return apiError("Participant is already enrolled in this program.", 409);
        }
        logger.error("Enrollment creation error:", error);
        return apiError("Failed to enroll participant", 500);
    }
});

const REMOVAL_REASON_MAX_LEN = 2000;

const STOCK_WARNING = "Participant enrolled, but the Shopify inventory change failed. Capacity may be out of sync — check System Status > Link Status.";

async function owesShortfall(programId: number): Promise<boolean> {
    const row = await prisma.program.findUnique({ where: { id: programId }, select: { shopifyStockCarry: true } });
    return (row?.shopifyStockCarry ?? 0) < 0;
}

async function isLeadOfParticipant(actorId: number, participantId: number): Promise<boolean> {
    const hh = await householdLeadship(actorId);
    if (!hh?.canManage) return false;
    const participant = await prisma.person.findUnique({ where: { id: participantId }, select: { householdId: true } });
    return sharesHousehold(hh.householdId, participant?.householdId);
}

export const DELETE = withAuth({}, async (req, auth, { params }: { params: Promise<{ id: string }> }) => {
    if (auth.type !== 'session') return apiError("Unauthorized", 401);
    const { id } = await params;

    try {
        const programId = parseId(id, "program ID");

        const body = await readObjectBody(req);
        const participantId = parseParticipantId(body.participantId);
        const reason = typeof body.reason === 'string' ? body.reason.trim() : '';

        if (reason.length > REMOVAL_REASON_MAX_LEN) {
            return apiError(`reason must be ${REMOVAL_REASON_MAX_LEN} characters or fewer`, 400);
        }
        if (body.mode !== undefined && body.mode !== 'remove' && body.mode !== 'withdraw') {
            return apiError("mode must be 'remove' or 'withdraw'", 400);
        }

        const currentProgram = await prisma.program.findUnique({
            where: { id: programId }
        });

        if (!currentProgram) {
            return apiError("Program not found", 404);
        }

        const currentUserId = auth.user.id;
        const isSelfRemoval = currentUserId === participantId;
        const isLeadMentor = currentProgram.leadMentorId === currentUserId;
        const isSysAdminOrBoard = auth.user.isSysadmin || auth.user.isBoardMember;

        // A household lead may withdraw only an unpaid enrollment: a paid
        // withdrawal (refund, restock) is the board's call. Enforced by the
        // conditional exit below, not a separate read, so a payment landing
        // mid-request cannot slip through.
        const isHouseholdLeadPath = !isSelfRemoval && !isLeadMentor && !isSysAdminOrBoard;
        // Same for an adult removing themselves: a paid place is not the household's
        // to withdraw — only the Board removes it.
        // "Paid" is decided on the place, not the program's price today: a place with
        // an order or an approved scholarship/payment plan stays paid even if the Board
        // later zeroes the price. A free program's never-paid place stays theirs.
        // ponytail: places paid before shopifyOrderId existed carry no order, so on a
        // still-priced program only PENDING goes; a backfill would let this drop isFree.
        const isFree = (currentProgram.orgMemberPriceCents ?? 0) === 0 && (currentProgram.nonOrgMemberPriceCents ?? 0) === 0;
        // Staff removing a place in their own household (or their own) has a
        // conflict of interest (Ethics Policy Art. III §III.5): they keep only the
        // household's own unpaid withdrawal, and someone outside removes a paid place.
        const isStaff = isLeadMentor || isSysAdminOrBoard;
        const subject = isStaff && !isSelfRemoval
            ? await prisma.person.findUnique({ where: { id: participantId }, select: { householdId: true } })
            : null;
        const isConflictedStaff = isStaff
            && (isSelfRemoval || await hasHouseholdConflict(prisma, currentUserId, subject?.householdId));
        // Only the Board removes a paid place, with a written reason (Standards of
        // Conduct §XVI.3). The Board role is read from the database, not the session.
        const isBoardRemoval = isStaff && !isConflictedStaff
            && !!(await prisma.person.findUnique({ where: { id: currentUserId }, select: { isBoardMember: true } }))?.isBoardMember;
        const unpaidOnly = !(isBoardRemoval && reason);
        const unpaidWhere: Prisma.ProgramParticipantWhereInput = isHouseholdLeadPath || !isFree
            ? { status: 'PENDING' }
            : { OR: [{ status: 'PENDING' }, { shopifyOrderId: null, wasOrgMemberAtApproval: null, OR: [{ enrollmentBasis: null }, { enrollmentBasis: 'COMP' }] }] };
        if (isHouseholdLeadPath && !(await isLeadOfParticipant(currentUserId, participantId))) {
            return apiError("Forbidden: Not authorized to remove this participant", 403);
        }

        // Withdrawal is a household lead's action, not a youth's: beyond matching
        // the enroll gate, withdrawing a scholarship-held seat releases inventory
        // back to Shopify below — a financial side effect a youth must not fire.
        if (isSelfRemoval && !isSysAdminOrBoard) {
            const self = await prisma.person.findUnique({
                where: { id: participantId },
                select: { dateOfBirth: true, isDeclaredAdult: true },
            });
            if (self && !isKnownAdult(self)) {
                return apiError("A household lead must withdraw a participant under 18.", 403);
            }
        }

        const current = await prisma.programParticipant.findUnique({
            where: { programId_personId: { programId, personId: participantId } },
            select: { status: true },
        });
        if (!current || current.status === 'WITHDRAWN') {
            return NextResponse.json({ success: true, idempotent: true });
        }

        // "remove" deletes a place nobody really took up; "withdraw" keeps the row
        // as history. Unchosen, a PENDING place is removed and an ACTIVE one
        // withdrawn. Either exit is pinned to the status read here, so a payment
        // landing mid-request gets a 409 instead of an exit chosen for the old status.
        const mode = body.mode === 'remove' || body.mode === 'withdraw' ? body.mode : current.status === 'ACTIVE' ? 'withdraw' : 'remove';
        const only: Prisma.ProgramParticipantWhereInput = {
            AND: [{ status: current.status }, unpaidOnly ? unpaidWhere : {}],
        };

        // A seat taken out of Shopify without a payment — a scholarship hold, or
        // a comped/approved place — goes back on sale (+1) with the exit, exactly
        // once (see deleteAndReleaseHold / withdrawParticipant). The audit commits
        // with the exit: a removal's audit is the only record that its order spent a seat.
        const exitOptions: ExitOptions = {
            inRequest: true,
            audit: (tx, enrollment) => tx.auditLog.create({
                data: {
                    actorId: currentUserId,
                    action: mode === 'withdraw' ? 'EDIT' : 'DELETE',
                    tableName: 'ProgramParticipant',
                    affectedEntityId: participantId,
                    secondaryAffectedEntity: programId,
                    ...(mode === 'withdraw'
                        ? { newData: { ...enrollment, ...(reason && { reason }) } }
                        : { oldData: enrollment, ...(reason && { newData: { reason } }) }),
                },
            }),
        };
        let exit: Awaited<ReturnType<typeof withdrawParticipant>>;
        try {
            exit = mode === 'withdraw'
                ? await withdrawParticipant(programId, participantId, currentProgram, only, exitOptions)
                : await deleteAndReleaseHold(programId, participantId, currentProgram, only, exitOptions);
        } catch (error) {
            if (!isPrismaError(error, 'P2025')) throw error;
            exit = null;
        }
        if (!exit) {
            const row = await prisma.programParticipant.findUnique({
                where: { programId_personId: { programId, personId: participantId } },
                select: { status: true },
            });
            if (unpaidOnly && row?.status === 'ACTIVE') {
                if (isConflictedStaff) {
                    return apiError("This place is paid and is in your own household; someone outside your household must remove it.", 403);
                }
                if (isBoardRemoval) {
                    return apiError("A written reason is required to remove a paid place.", 400);
                }
                if (isStaff) {
                    return apiError("Only the Board removes a paid place.", 403);
                }
                return apiError(isSelfRemoval
                    ? "Your place is paid; ask the board to withdraw you."
                    : "This child has paid; ask the board to withdraw them.", 403);
            }
            if (row && row.status !== 'WITHDRAWN') {
                return apiError("This place changed while it was being removed. Reload and try again.", 409);
            }
            return NextResponse.json({ success: true, idempotent: true });
        }
        const { released, shopifyOk } = exit;

        // Nothing here may reveal whether a scholarship hold existed: this route
        // is reachable by the program's lead mentor, who must never see
        // scholarship / payment-plan status. So no enrollment echo, no
        // `released` flag, and the hold-release warning is staff-only. The audit
        // log above keeps the full row server-side.
        const responseObj: Record<string, unknown> = { success: true };
        if (isSysAdminOrBoard && released && !shopifyOk) {
            responseObj.warning = "Participant removed, but the Shopify inventory release failed. Capacity may be out of sync — check System Status > Link Status.";
        }

        // Advise a manual Shopify restock only when a paid removal freed a
        // tracked seat; `released` covers the holds and comps put back (+1).
        // Staff-only: a lead mentor or self-removing parent can't act on Shopify
        // inventory, so the advisory is noise (and a foot-gun) for them.
        const hasShopifyVariant = !!currentProgram.shopifyVariantId;
        // After the sale ends a freed seat is not resold, so there is nothing to advise.
        // An over-capacity program (negative carry) owes this seat to its shortfall, not to the store.
        if (isSysAdminOrBoard && !released && current.status === 'ACTIVE' && currentProgram.maxParticipants !== null && hasShopifyVariant && !isSaleEnded(currentProgram)
            && !(await owesShortfall(programId))) {
            responseObj.notice = "Seat freed. This enrollment held a seat in Shopify; it was NOT put back on sale automatically. If you want it available for a paying family, add +1 to this program's inventory in Shopify.";
        }
        return NextResponse.json(responseObj);
    } catch (error) {
        if (isComponentHttpError(error)) {
            return apiError(error.message, error.status);
        }
        // P2025 = row to delete not found. Benign double-submit (participant
        // already un-enrolled); idempotent 200 instead of a 500.
        if (isPrismaError(error, 'P2025')) {
            return NextResponse.json({ success: true, idempotent: true });
        }
        logger.error("Enrollment deletion error:", error);
        return apiError("Failed to remove participant", 500);
    }
});
