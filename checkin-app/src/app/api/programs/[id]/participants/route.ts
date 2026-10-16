import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { withAuth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { isPrismaError } from "@/lib/prismaUniqueViolation";
import { sendNotification } from "@/lib/notifications";
import { lockProgramAndCheckCapacity, ProgramCapacityError, withdrawAndReleaseHold } from "@/lib/program/capacity";
import { checkProgramAge, isKnownAdult } from "@/lib/programAge";
import { hasHouseholdConflict, sharesHousehold } from "@/lib/conflictOfInterest";
import { householdLeadship } from "@/lib/household/leads";
import { isDuesSettled } from "@/lib/orgMembership";
import { isProgramCheckoutBroken } from "@/lib/programCheckout";
import { changeProgramStock } from "@/lib/shopify";
import { isSaleEnded } from "@/lib/programs/saleState";
import { apiError } from "@/lib/api-response";

export const POST = withAuth({}, async (req, auth, { params }: { params: Promise<{ id: string }> }) => {
    if (auth.type !== 'session') return apiError("Unauthorized", 401);
    const { id } = await params;

    try {
        const programId = parseInt(id, 10);
        if (isNaN(programId)) {
            return apiError("Invalid program ID", 400);
        }

        const body = await req.json();
        const { participantId } = body;

        if (!participantId) {
            return apiError("participantId is required", 400);
        }

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

        const participantData = await prisma.person.findUnique({
            where: { id: participantId },
            select: { dateOfBirth: true, isDeclaredAdult: true, householdId: true }
        });

        let isHouseholdLead = false;
        if (participantData?.householdId) {
            const leadRecord = await prisma.person.findFirst({
                where: {
                    id: currentUserId,
                    householdId: participantData.householdId,
                    isHouseholdLead: true
                },
                select: { id: true }
            });
            isHouseholdLead = !!leadRecord;
        }

        if (!isSelfEnrollment && !isSysAdminOrBoard && !isHouseholdLead) {
            return apiError("Forbidden: Not authorized to enroll this participant. Program leads cannot manually add participants.", 403);
        }

        // A family that claimed in time can always pay: an existing PENDING
        // claim skips every limit below (capacity would count its own row) and
        // gets the 409 the program page folds back into its checkout.
        const existingClaim = await prisma.programParticipant.findUnique({
            where: { programId_personId: { programId, personId: participantId } },
            select: { status: true },
        });
        if (existingClaim?.status === 'PENDING') {
            return apiError("Participant is already enrolled in this program.", 409);
        }

        const override = body.override === true;

        // Conflict of interest: an override and a comp are both one-actor
        // decisions, so neither may be spent on yourself or your own household.
        // Self is its own leg — an actor with no household is not caught by the
        // household comparison, but is still enrolling themselves. This is the
        // route's single notion of "own household"; `isHouseholdLead` above
        // answers a different question (may you act for this person at all).
        const isConflicted = isSelfEnrollment
            || await hasHouseholdConflict(prisma, currentUserId, participantData?.householdId);

        // A board/isSysadmin enrolling someone OUTSIDE their own household (the
        // program-ops surface) is a real admin comp: it skips payment. A board
        // member enrolling their own self/dependent through the public program
        // page is just a parent — they pay like anyone else, whether or not they
        // happen to be the household's lead.
        const isExternalAdmin = isSysAdminOrBoard && !isConflicted;

        if (isExternalAdmin && !override) {
             return NextResponse.json({ error: "This bypasses all payment. Are you sure?", requiresOverride: true }, { status: 400 });
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
            // must be refused here. Dues-settled, not ACTIVE — it admits a paid
            // household awaiting background clearance, matching the read gates.
            if (currentProgram.orgMemberOnly && !(await isDuesSettled(participantId))) {
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
        
        // PENDING (awaits payment) unless the program is free or an external
        // admin is comping it. A board parent overriding a soft limit for their
        // own household still pays — the override bypasses limits, not the fee.
        const initialStatus = ((isExternalAdmin && override) || isFree) ? 'ACTIVE' : 'PENDING';

        // Fail closed on a priced-but-unsellable program: PENDING means "awaits a
        // Shopify payment", and a priced program with no variant has nothing to
        // pay through — the seat would sit PENDING forever. Keyed off the status,
        // not the actor, so an admin comp (ACTIVE, skips payment entirely) still
        // goes through while every payment-bound enrollment — including a
        // conflicted admin's override, which still owes the fee — is refused.
        // No requiresOverride: an override cannot make the program sellable.
        if (initialStatus === 'PENDING' && isProgramCheckoutBroken(currentProgram)) {
            return apiError("This program has a price but no payment link set up, so enrollment can't be paid for. An admin must fix the Shopify link in program-ops before anyone can enroll.", 400);
        }

        // A comp takes its seat out of Shopify stock (below). The stamp goes in with the
        // row, so a crash before the -1 is recorded leaves a stamp, not a lost seat.
        const takesSeatWithoutSale = isExternalAdmin && override && currentProgram.maxParticipants !== null;
        const enrollment = await prisma.$transaction(async (tx) => {
            // Re-check capacity under a row lock right before insert, so
            // concurrent enrollers can't both pass a stale count and overfill.
            if (enforceLimits) {
                await lockProgramAndCheckCapacity(tx, programId, 1, currentProgram.maxParticipants);
            }
            return tx.programParticipant.create({
                data: {
                    programId,
                    personId: participantId,
                    status: initialStatus,
                    ...(takesSeatWithoutSale && { seatTakenWithoutSaleAt: new Date() }),
                }
            });
        });

        await prisma.auditLog.create({
            data: {
                actorId: currentUserId,
                action: 'CREATE',
                tableName: 'ProgramParticipant',
                affectedEntityId: participantId,
                secondaryAffectedEntity: programId,
                newData: enrollment
            }
        });

        // Trigger notification
        await sendNotification(participantId, 'PROGRAM_ENROLLMENT', { programName: currentProgram.name });

        // A board/sysadmin comp (external admin, confirmed override) seats a
        // participant WITHOUT a Shopify checkout, so unlike a normal PENDING
        // enrollment nothing ever fires Shopify's own sale-time -1. Reconcile it
        // here: -1 on the pool, exactly like a paid sale and like scholarship
        // apply (request-payment-plan -1). Without it the roster takes a seat
        // the storefront still shows as available (oversell).
        //
        // A comp is ACTIVE, so it deliberately does NOT use the inventoryHeldAt
        // hold-ledger: invariants I1/I2/I3 (enrollmentState.ts) make a held seat
        // PENDING-and-scholarship only, and the lifecycle reconciler auto-heals
        // an ACTIVE+held row by releasing +1 — which would silently undo this
        // decrement. A recorded -1 is stamped (seatTakenWithoutSaleAt), and
        // withdrawing the comp puts that seat back on sale (+1, see
        // withdrawAndReleaseHold), unlike a paid seat. Uncapped programs track no
        // inventory (inventory_management=null), so only capped programs adjust;
        // changeProgramStock additionally no-ops when no variant is wired.
        let warning: string | undefined;
        if (takesSeatWithoutSale) {
            // Enrollment already committed above; on Shopify failure keep it and
            // warn (the stock writer has logged + emailed the board),
            // mirroring the cap-edit and withdraw siblings.
            const stock = await changeProgramStock(currentProgram, -1, "comp", { inRequest: true });
            // Recorded = owed in the carry, so it lands later even if this push failed and
            // the stamp stands. Only an unrecorded -1 rolls the stamp back, so a withdrawal
            // does not put back a seat that was never taken out.
            if (!stock.recorded) {
                await prisma.programParticipant.updateMany({
                    where: { programId, personId: participantId, seatTakenWithoutSaleAt: { not: null } },
                    data: { seatTakenWithoutSaleAt: null },
                });
            }
            if (!stock.landed) {
                warning = "Participant added, but the Shopify inventory decrement failed. Capacity may be out of sync — check System Status > Link Status.";
            }
        }

        const responseObj: Record<string, unknown> = { success: true, enrollment };
        if (warning) responseObj.warning = warning;
        return NextResponse.json(responseObj);
    } catch (error) {
        if (error instanceof ProgramCapacityError) {
            return NextResponse.json({ error: "Program has reached maximum capacity.", requiresOverride: true }, { status: 400 });
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
        const programId = parseInt(id, 10);
        if (isNaN(programId)) {
            return apiError("Invalid program ID", 400);
        }

        const body = await req.json();
        const { participantId } = body;

        if (!participantId) {
            return apiError("participantId is required", 400);
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
        // conditional delete below, not a separate read, so a payment landing
        // mid-request cannot slip through.
        const isHouseholdLeadPath = !isSelfRemoval && !isLeadMentor && !isSysAdminOrBoard;
        // Same for an adult removing themselves from a priced program: a paid place is
        // not the household's to withdraw — the board, a sysadmin or the program's
        // leader removes it. A free program's place was never paid, so it stays theirs.
        const isFree = (currentProgram.orgMemberPriceCents ?? 0) === 0 && (currentProgram.nonOrgMemberPriceCents ?? 0) === 0;
        const unpaidOnly = isHouseholdLeadPath || (isSelfRemoval && !isLeadMentor && !isSysAdminOrBoard && !isFree);
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

        // A seat taken out of Shopify without a payment — a scholarship hold, or
        // a comped/approved place — goes back on sale (+1) with the removal,
        // exactly once (see withdrawAndReleaseHold).
        let withdrawal: Awaited<ReturnType<typeof withdrawAndReleaseHold>>;
        try {
            withdrawal = await withdrawAndReleaseHold(programId, participantId, currentProgram, unpaidOnly ? 'PENDING' : undefined, { inRequest: true });
        } catch (error) {
            if (unpaidOnly && isPrismaError(error, 'P2025')) {
                const row = await prisma.programParticipant.findUnique({
                    where: { programId_personId: { programId, personId: participantId } },
                    select: { status: true },
                });
                if (row?.status === 'ACTIVE') {
                    return apiError(isSelfRemoval
                        ? "Your place is paid; ask the board to withdraw you."
                        : "This child has paid; ask the board to withdraw them.", 403);
                }
            }
            throw error;
        }
        const { enrollment, released, shopifyOk } = withdrawal;

        await prisma.auditLog.create({
            data: {
                actorId: currentUserId,
                action: 'DELETE',
                tableName: 'ProgramParticipant',
                affectedEntityId: participantId,
                secondaryAffectedEntity: programId,
                oldData: enrollment
            }
        });

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
        if (isSysAdminOrBoard && !released && enrollment.status === 'ACTIVE' && currentProgram.maxParticipants !== null && hasShopifyVariant && !isSaleEnded(currentProgram)
            && !(await owesShortfall(programId))) {
            responseObj.notice = "Seat freed. This enrollment held a seat in Shopify; it was NOT put back on sale automatically. If you want it available for a paying family, add +1 to this program's inventory in Shopify.";
        }
        return NextResponse.json(responseObj);
    } catch (error) {
        // P2025 = row to delete not found. Benign double-submit (participant
        // already un-enrolled); idempotent 200 instead of a 500.
        if (isPrismaError(error, 'P2025')) {
            return NextResponse.json({ success: true, idempotent: true });
        }
        logger.error("Enrollment deletion error:", error);
        return apiError("Failed to remove participant", 500);
    }
});
