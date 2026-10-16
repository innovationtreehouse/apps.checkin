import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { withAuth, authenticateRequest } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { handler, notFound, forbidden, badRequest } from "@/security/handler";
import { isActiveOrgMember, isDuesSettled, isDuesSettledThrough, programCoverageDate } from "@/lib/orgMembership";
import { maybeAnnounceOnOpen } from "@/lib/programAnnounce";
import { adjustProgramInventory, setProgramInventory, STOCK_BOOKKEEPING_RESET, syncProgramPrice } from "@/lib/shopify";
import { dollarsToCentsOrNull } from "@inventory/money";
import { apiError } from "@/lib/api-response";
import { LIVE_PERSON } from "@/lib/person/filters";
import { validateProgramAgeBounds, isLeaderAgeEligible, checkProgramAge } from "@/lib/programAge";
import { hasHouseholdConflict } from "@/lib/conflictOfInterest";
import { householdPaymentViewer } from "@/lib/programs/paymentVisibility";
import { emailBoardMembers } from "@/lib/emailRecipients";
import { config } from "@/lib/config";
import { escapeHtml } from "@/lib/email-templates/base";
import { parseDateOnly } from "@/lib/time";
import { isSaleEnded, saleStockDelta } from "@/lib/programs/saleState";
import { countStockTakenSeats } from "@/lib/program/capacity";
import { ProgramPhase, EnrollmentStatus, type Program } from "@/generated/prisma/client";

// ORDER MATTERS: this export sits ABOVE getProgram so the routeAuthDrift
// guard attributes getProgram's edge-model reads to the nearest preceding
// exported METHOD (this GET) — moving it below silently un-attributes them.
// The registry stripper (security/stripper.ts) is a strict allowlist over each
// model's CLASSIFIED schema fields (see security/generated/classifications.ts,
// generated from /// @sensitivity comments) — it has no channel for a
// viewer-computed scalar that isn't a real Program column, and adding one
// would mean a schema change this feature doesn't get. So viewerIsMember /
// viewerMemberPricingEligible are computed AFTER the registry response comes
// back and merged on top, session callers only — the registry envelope above
// (association gate, per-tier stripping) runs completely untouched first.
// startAt/endAt are 'public' tier, so they always ride in `body` regardless of
// caller privilege; re-authenticating here is the same cheap session read
// authenticateRequest always does, just called a second time.
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
    const res = await getProgram(req, ctx);
    if (res.status !== 200) return res;

    const auth = await authenticateRequest(req);
    if (auth.type !== 'session') return res;

    const body = (await res.json()) as { startAt: string; endAt: string };
    const coverageDate = programCoverageDate({
        endAt: new Date(body.endAt),
    });
    // viewerIsMember answers "is this household a Treehouse Member" (ACTIVE only);
    // viewerMemberPricingEligible answers the pricing question, which also covers a
    // paid household still awaiting background clearance.
    const [viewerIsMember, viewerMemberPricingEligible] = await Promise.all([
        isActiveOrgMember(auth.user.id),
        isDuesSettledThrough(auth.user.id, coverageDate),
    ]);
    return NextResponse.json({ ...body, viewerIsMember, viewerMemberPricingEligible });
}

const getProgram = handler<{ id: string }>('GET /api/programs/[id]', async ({ auth, params }) => {
    const programId = parseInt(params.id, 10);
    if (isNaN(programId)) throw badRequest('Invalid program ID');

    // Explicit select, not include: whole rows would ship every pii/personal
    // column a lead mentor's view happens to grant (googleId, dateOfBirth,
    // allergies, the payment-plan flags) plus any column added later. The id /
    // programId / personId / householdId keys below are ROW_SCOPE_KEYs — drop
    // one and scopesHeld() fails closed and strips the row for the very roles
    // this route serves (see the emergencyContacts note).
    const program = await prisma.program.findUnique({
        where: { id: programId },
        select: {
            id: true,
            name: true,
            leadMentorId: true,
            startAt: true,
            endAt: true,
            offSaleAt: true,
            phase: true,
            enrollmentStatus: true,
            orgMemberOnly: true,
            publiclyVisible: true,
            announceOnOpen: true,
            minAge: true,
            maxAge: true,
            maxParticipants: true,
            orgMemberPriceCents: true,
            nonOrgMemberPriceCents: true,
            shopifyProductId: true,
            shopifyVariantId: true,
            claimantShopifyVariantId: true,
            volunteers: {
                where: { person: LIVE_PERSON },
                select: {
                    programId: true,
                    personId: true,
                    isCore: true,
                    person: { select: { id: true, name: true, email: true } },
                },
            },
            participants: {
                where: { person: LIVE_PERSON },
                select: {
                    programId: true,
                    personId: true,
                    status: true,
                    pendingSince: true,
                    person: {
                        select: {
                            id: true,
                            name: true,
                            email: true,
                            householdId: true,
                            household: {
                                select: {
                                    id: true,
                                    // The family's parents, for the roster's "call someone" band.
                                    // householdId and isHouseholdLead are BOTH scope keys for the
                                    // Person their_program_households binding: drop either and a
                                    // lead resolves no scope, so name/email/phone strip away.
                                    householdMembers: {
                                        where: { isHouseholdLead: true, ...LIVE_PERSON },
                                        orderBy: { id: "asc" },
                                        select: { id: true, householdId: true, isHouseholdLead: true, name: true, email: true, phone: true },
                                    },
                                    emergencyContacts: {
                                        where: { conflictParticipantId: null, name: { not: "" }, phone: { not: "" } },
                                        orderBy: [{ priority: "asc" }, { id: "asc" }],
                                        // householdId is the EmergencyContact ROW_SCOPE_KEY: without it
                                        // scopesHeld() fails closed (empty scope set) and the stripper drops
                                        // name/phone/relationship for EVERY viewer, incl. admin/board.
                                        select: { id: true, householdId: true, name: true, phone: true, relationship: true },
                                    },
                                },
                            },
                        },
                    },
                },
            },
            events: {
                orderBy: { startAt: 'asc' },
                select: {
                    id: true,
                    programId: true,
                    name: true,
                    startAt: true,
                    endAt: true,
                    attendanceConfirmedAt: true,
                },
            },
            leadMentor: { select: { id: true, name: true, email: true } },
            _count: { select: { participants: { where: { person: LIVE_PERSON } }, volunteers: { where: { person: LIVE_PERSON } } } },
        },
    });

    if (!program) throw notFound('Program not found');

    const isSessionUser = auth.type === 'session';
    const sessionUser = isSessionUser ? auth.user : undefined;
    const isSysAdminOrBoard = !!(sessionUser?.isSysadmin || sessionUser?.isBoardMember);
    const isLeadMentor = !!sessionUser && sessionUser.id === program.leadMentorId;
    const isCoreVolunteer = !!sessionUser && program.volunteers.some(v => v.personId === sessionUser.id && v.isCore);
    const isPrivileged = isSysAdminOrBoard || isLeadMentor || isCoreVolunteer;

    // A members-only program is hidden unless its leader opted it into the public
    // catalogue (publiclyVisible) — then anyone may view its detail, but the
    // enrollment route still gates joining on a settled membership. Dues settled,
    // not "is a member": a paid household awaiting background clearance is admitted.
    if (program.orgMemberOnly && !program.publiclyVisible && !isPrivileged) {
        if (!sessionUser) throw notFound('Program not found');
        const duesSettled = await isDuesSettled(sessionUser.id);
        if (!duesSettled) throw forbidden('Forbidden: Member-Only Program');
    }

    // ── Association gate (deliberate inline exception) ──────────────────────────
    // The participant/volunteer ROSTER reveals who is enrolled in this program.
    // Each ProgramParticipant/ProgramVolunteer row AND Participant.name are tier
    // 'public', so the handler's per-field stripper CANNOT hide the association:
    // the existence of the row + the public name = the enrollment fact (incl.
    // youth). Only admission can hide it. The registry `authorize` grammar can't
    // express "enrolled in THIS program" per-relation, so the gate lives here —
    // mirrors events/[id]; see docs/security/auth-consistency-analysis.md
    // §4 (principled exception) and §5.1a. The route stays `authorize: 'public'`
    // because the catalog metadata (name/price/dates/spots) drives the public
    // registration page; only the roster is gated.
    //
    // Staff (admin/board/lead/core-vol) or a member of an enrolled household see
    // the rows; everyone else (anonymous, plain authenticated non-enrolled) gets
    // metadata + counts only. The public details/enroll page needs spots-remaining
    // (_count.participants), not names — a count is fine, the names are the leak.
    // The registry orderedView tiers remain as defense-in-depth, stripping
    // pii/personal on the rows for non-staff-but-enrolled callers.
    // The household is read from the DB, not the session, so a move applies at once.
    const viewerHouseholdId = sessionUser && !isPrivileged
        ? (await prisma.person.findFirst({ where: { id: sessionUser.id, ...LIVE_PERSON }, select: { householdId: true } }))?.householdId
        : undefined;
    const isOwnHousehold = (p: { personId: number; person: { householdId: number } | null }) => !!sessionUser && (
        p.personId === sessionUser.id ||
        (viewerHouseholdId != null && p.person?.householdId === viewerHouseholdId)
    );
    const isEnrolled = program.participants.some(isOwnHousehold);
    if (!isPrivileged && !isEnrolled) {
        const metadata: Record<string, unknown> = { ...program };
        delete metadata.volunteers;
        delete metadata.participants;
        return { Program: metadata };
    }
    if (isPrivileged) return { Program: program };

    // Payment status (status = paid vs not paid yet) is staff's, plus a household
    // lead's for their own household. The stripper can't express "own household",
    // so other rows are dropped of it here — including every row for a youth.
    // The household is read from the DB, not the session, so a move applies at once.
    const viewer = sessionUser ? await householdPaymentViewer(sessionUser.id) : null;
    const seesPayment = (p: { personId: number; person: { householdId: number } | null }) => !!viewer && (
        p.personId === sessionUser?.id ||
        p.person?.householdId === viewer.householdId
    );
    const participants = program.participants.map(({ status, pendingSince, ...row }) =>
        seesPayment(row) ? { ...row, status, pendingSince } : row
    );
    return { Program: { ...program, participants } };
});


// withAuth rejects unauthenticated AND denied households at admission, so a
// denied lead mentor cannot edit their program.
export const PATCH = withAuth({}, async (req, auth, ctx: { params: Promise<{ id: string }> }) => {
    if (auth.type !== 'session') return apiError("Unauthorized", 401);
    const { id } = await ctx.params;

    try {
        const programId = parseInt(id, 10);
        if (isNaN(programId)) {
            return apiError("Invalid program ID", 400);
        }

        const currentProgram = await prisma.program.findUnique({ where: { id: programId } });
        if (!currentProgram) {
            return apiError("Program not found", 404);
        }

        const user = auth.user;
        const isLeadMentor = currentProgram.leadMentorId === user.id;
        const isSysAdminOrBoard = user.isSysadmin || user.isBoardMember;

        if (!isLeadMentor && !isSysAdminOrBoard) {
            return apiError("Forbidden: Only Admin, Board Members, or Lead Mentors can edit", 403);
        }

        const body = await req.json();
        let { leadMentorId } = body;
        const { name, startAt, endAt, orgMemberOnly, publiclyVisible, announceOnOpen, phase, enrollmentStatus, minAge, maxAge, maxParticipants, leadMentorNotificationSettings, memberPrice, nonMemberPrice, shopifyProductId, shopifyVariantId } = body;

        if (announceOnOpen !== undefined && typeof announceOnOpen !== "boolean") {
            return apiError("announceOnOpen must be a boolean", 400);
        }
        if (publiclyVisible !== undefined && typeof publiclyVisible !== "boolean") {
            return apiError("publiclyVisible must be a boolean", 400);
        }
        if (phase !== undefined && !Object.values(ProgramPhase).includes(phase)) {
            return apiError("Invalid phase", 400);
        }
        if (enrollmentStatus !== undefined && !Object.values(EnrollmentStatus).includes(enrollmentStatus)) {
            return apiError("Invalid enrollmentStatus", 400);
        }

        // Age range sanity — effective values (body overrides current) so a
        // one-sided edit can't leave minAge > maxAge.
        const effMinAge = minAge !== undefined ? minAge : currentProgram.minAge;
        const effMaxAge = maxAge !== undefined ? maxAge : currentProgram.maxAge;
        const ageErr = validateProgramAgeBounds(effMinAge, effMaxAge);
        if (ageErr) {
            return apiError(ageErr, 400);
        }

        // maxParticipants: null = uncapped (allowed). Otherwise must be a
        // positive int and not below current enrollment.
        if (maxParticipants !== undefined && maxParticipants !== null) {
            if (typeof maxParticipants !== "number" || !Number.isInteger(maxParticipants) || maxParticipants <= 0) {
                return apiError("maxParticipants must be a positive integer", 400);
            }
            const enrolled = await prisma.programParticipant.count({ where: { programId, person: LIVE_PERSON } });
            if (maxParticipants < enrolled) {
                return apiError(`maxParticipants cannot be set below the current enrollment of ${enrolled}`, 400);
            }
        }

        if (body.hasOwnProperty('leadMentorId')) {
            if (!leadMentorId) {
                return apiError("Lead Mentor is required", 400);
            }
            leadMentorId = parseInt(leadMentorId);
            if (isNaN(leadMentorId)) {
                return apiError("Invalid lead mentor", 400);
            }
            if (!isSysAdminOrBoard && leadMentorId !== currentProgram.leadMentorId) {
                return apiError("Forbidden: Only administrators can reassign lead mentors", 403);
            }
            const mentor = await prisma.person.findUnique({
                where: { id: leadMentorId },
                select: { dateOfBirth: true, isDeclaredAdult: true, householdId: true },
            });
            if (!mentor) {
                return apiError("Lead mentor not found", 400);
            }
            if (!isLeaderAgeEligible(mentor)) {
                return apiError("Lead mentor must be at least 23 years old", 400);
            }
            // Leading a program makes its leader an expense approver. The edit form
            // resends the current lead on every save, so only a change is refused.
            if (leadMentorId !== currentProgram.leadMentorId && (
                leadMentorId === user.id || await hasHouseholdConflict(prisma, user.id, mentor.householdId)
            )) {
                return apiError("Forbidden: You cannot make yourself or a member of your household a program lead", 403);
            }
        }

        // Publish guards: transitioning to UPCOMING requires a lead mentor and
        // at least one scheduled event. Re-publishing a RUNNING or FINISHED
        // program is rejected — prevents silently resurrecting a terminal program.
        if (phase === 'UPCOMING' && currentProgram.phase !== 'UPCOMING') {
            if (currentProgram.phase === 'RUNNING' || currentProgram.phase === 'FINISHED') {
                return apiError(`Cannot publish a program that is already ${currentProgram.phase.toLowerCase()}.`, 409);
            }
            const effLeadMentorId = leadMentorId !== undefined ? leadMentorId : currentProgram.leadMentorId;
            if (!effLeadMentorId) {
                return apiError("Cannot publish a program without a Lead Mentor assigned", 400);
            }
            const eventCount = await prisma.event.count({ where: { programId } });
            if (eventCount === 0) {
                return apiError("Cannot publish a program without any scheduled events", 400);
            }
        }

        if (startAt !== undefined && !startAt) {
            return apiError("Start date is required", 400);
        }
        if (endAt !== undefined && !endAt) {
            return apiError("End date is required", 400);
        }
        const newStartAt = startAt !== undefined ? parseDateOnly(startAt) : undefined;
        const newEndAt = endAt !== undefined ? parseDateOnly(endAt) : undefined;
        if ((startAt !== undefined && typeof startAt !== "string") || (newStartAt && isNaN(newStartAt.getTime()))) {
            return apiError("Invalid start date", 400);
        }
        if ((endAt !== undefined && typeof endAt !== "string") || (newEndAt && isNaN(newEndAt.getTime()))) {
            return apiError("Invalid end date", 400);
        }
        // Effective values (body overrides current) so a one-sided edit can't invert the range.
        const effStartAt = newStartAt ?? currentProgram.startAt;
        const effEndAt = newEndAt ?? currentProgram.endAt;
        if (effStartAt > effEndAt) {
            return apiError("Start date must be on or before the end date", 400);
        }

        // Off-sale date: board-only. null follows the start date. An untouched
        // date still equal to the start date moves with it, unless the sale has
        // ended: then moving the start leaves the sale ended.
        const { offSaleAt } = body;
        if (offSaleAt !== undefined && !user.isBoardMember) {
            return apiError("Forbidden: Only the board can change the off-sale date", 403);
        }
        if (offSaleAt != null && (typeof offSaleAt !== "string" || isNaN(Date.parse(offSaleAt)))) {
            return apiError("Invalid off-sale date", 400);
        }
        const saleEndedNow = isSaleEnded(currentProgram);
        const followsStart = currentProgram.offSaleAt == null
            || currentProgram.offSaleAt.getTime() === currentProgram.startAt.getTime();
        const newOffSaleAt = offSaleAt !== undefined
            ? parseDateOnly(offSaleAt)
            : !newStartAt || !followsStart ? undefined
            : saleEndedNow ? currentProgram.offSaleAt ?? currentProgram.startAt
            : newStartAt;
        // Only the board reopens an ended sale, by moving the off-sale date itself
        // later: that re-arms the sweep. Enrollment stays closed unless this save opens it.
        const rearmSale = user.isBoardMember && saleEndedNow && offSaleAt !== undefined
            && !isSaleEnded({ startAt: newStartAt ?? currentProgram.startAt, offSaleAt: newOffSaleAt ?? null, saleEndedAt: null });
        if (enrollmentStatus === 'OPEN' && currentProgram.enrollmentStatus !== 'OPEN' && saleEndedNow && !rearmSale) {
            return apiError("Sales for this program have ended. To reopen enrollment, move the off-sale date later.", 409);
        }

        // Variant⟺price invariant: a program has a Shopify variant iff it
        // has a price on some tier — the capacity/oversell math assumes this
        // everywhere. Compute the post-PATCH EFFECTIVE values (current row + body
        // deltas, undefined = "field not touched") and reject both illegal
        // directions on the merged result: wiring a variant onto a price-null
        // program, and nulling both prices out from under an existing variant.
        // One check on the effective state covers both — guarding only one
        // direction is a false sense of safety.
        const newOrgMemberPriceCents = memberPrice !== undefined
            ? dollarsToCentsOrNull(memberPrice != null ? String(memberPrice) : undefined)
            : undefined;
        const newNonOrgMemberPriceCents = nonMemberPrice !== undefined
            ? dollarsToCentsOrNull(nonMemberPrice != null ? String(nonMemberPrice) : undefined)
            : undefined;
        // Prices are sysadmin/board-only. The edit page echoes the current prices on
        // every save, so only a value that differs from the stored one is rejected.
        if (!isSysAdminOrBoard && (
            (newOrgMemberPriceCents !== undefined && newOrgMemberPriceCents !== currentProgram.orgMemberPriceCents) ||
            (newNonOrgMemberPriceCents !== undefined && newNonOrgMemberPriceCents !== currentProgram.nonOrgMemberPriceCents)
        )) {
            return apiError("Forbidden: Only administrators can change program prices", 403);
        }
        // Shopify identifiers are sysadmin/board-only, so a non-privileged caller's
        // effective variant is always the current one regardless of what's in body.
        const newShopifyVariantId = (isSysAdminOrBoard && shopifyVariantId !== undefined)
            ? (shopifyVariantId || null)
            : undefined;
        const effOrgMemberPriceCents = newOrgMemberPriceCents !== undefined ? newOrgMemberPriceCents : currentProgram.orgMemberPriceCents;
        const effNonOrgMemberPriceCents = newNonOrgMemberPriceCents !== undefined ? newNonOrgMemberPriceCents : currentProgram.nonOrgMemberPriceCents;
        const effShopifyVariantId = newShopifyVariantId !== undefined ? newShopifyVariantId : currentProgram.shopifyVariantId;
        if (effShopifyVariantId && effOrgMemberPriceCents == null && effNonOrgMemberPriceCents == null) {
            return apiError("A program cannot have a Shopify variant without a price on at least one tier", 400);
        }

        const updateData: Record<string, unknown> = {
            ...(name !== undefined && { name }),
            ...(leadMentorId !== undefined && { leadMentorId }),
            ...(newStartAt !== undefined && { startAt: newStartAt }),
            ...(newEndAt !== undefined && { endAt: newEndAt }),
            ...(newOffSaleAt !== undefined && { offSaleAt: newOffSaleAt }),
            ...(rearmSale && { saleEndedAt: null, unpaidClaimsNotifiedAt: null, productHiddenAt: null }),
            ...(orgMemberOnly !== undefined && { orgMemberOnly }),
            // publiclyVisible only has meaning for a members-only program. Recompute
            // it on the POST-PATCH effective state so neither flipping orgMemberOnly
            // off (leaving a stale publiclyVisible) nor setting publiclyVisible on a
            // public program can store the nonsense "public-but-publiclyVisible" row.
            ...((orgMemberOnly !== undefined || publiclyVisible !== undefined) && {
                publiclyVisible:
                    (orgMemberOnly !== undefined ? orgMemberOnly : currentProgram.orgMemberOnly) &&
                    (publiclyVisible !== undefined ? publiclyVisible : currentProgram.publiclyVisible),
            }),
            ...(announceOnOpen !== undefined && { announceOnOpen }),
            ...(phase !== undefined && { phase }),
            ...(enrollmentStatus !== undefined && { enrollmentStatus }),
            ...(minAge !== undefined && { minAge }),
            ...(maxAge !== undefined && { maxAge }),
            ...(maxParticipants !== undefined && { maxParticipants }),
            ...(leadMentorNotificationSettings !== undefined && { leadMentorNotificationSettings }),
            ...(newOrgMemberPriceCents !== undefined && { orgMemberPriceCents: newOrgMemberPriceCents }),
            ...(newNonOrgMemberPriceCents !== undefined && { nonOrgMemberPriceCents: newNonOrgMemberPriceCents }),
            // Shopify identifiers are sysadmin/board-only — a lead mentor's PATCH can't
            // touch them (they can break checkout, so they stay off the lead surface).
            // Empty string clears the field. This is the manual repair path when there's
            // no live Shopify to sync against (local/testing).
            ...(isSysAdminOrBoard && shopifyProductId !== undefined && { shopifyProductId: shopifyProductId || null }),
            ...(newShopifyVariantId !== undefined && { shopifyVariantId: newShopifyVariantId }),
            // What was owed or in flight belongs to the old variant's stock, not the new one's.
            ...(newShopifyVariantId !== undefined && newShopifyVariantId !== currentProgram.shopifyVariantId && STOCK_BOOKKEEPING_RESET),
        };

        const updatedProgram = await prisma.program.update({
            where: { id: programId },
            data: updateData
        });

        await prisma.auditLog.create({
            data: {
                actorId: auth.user.id,
                action: 'EDIT',
                tableName: 'Program',
                affectedEntityId: updatedProgram.id,
                oldData: currentProgram,
                newData: updatedProgram
            }
        });

        // The edit has landed; a failed re-check is logged, not reported as a failed save.
        await flagEnrollmentsNoLongerFitting(currentProgram, updatedProgram)
            .catch(e => logger.error("Program age re-check failed:", e));

        // Announce trigger — transition rule, once-per-lifetime claim, audit row,
        // and fire-without-await all live in the helper. Never throws.
        await maybeAnnounceOnOpen({
            programId: updatedProgram.id,
            before: currentProgram,
            after: updatedProgram,
            actorId: auth.user.id,
        });

        // Cap edits move public stock by the cap change, until the sale has ended.
        // Only fires when the program already has Shopify checkout wired up;
        // creation and sync-shopify set the initial stock themselves.
        let warning: string | undefined;
        const oldMax = currentProgram.maxParticipants;
        const newMax = updatedProgram.maxParticipants;
        const hasShopifyVariant = !!updatedProgram.shopifyVariantId;

        if (rearmSale && hasShopifyVariant && newMax !== null) {
            // Changes skipped while the sale was ended are lost to a relative push;
            // set the absolute stock instead: capacity minus seats Shopify counts
            // as taken. Not clamped: an overfilled program keeps its shortfall owed.
            if (!(await setProgramInventory(updatedProgram, async () => newMax - await countStockTakenSeats(programId), "re-arm"))) {
                warning = "Program updated, but setting the Shopify inventory failed. Capacity may be out of sync — check System Status > Link Status.";
            }
        } else if (oldMax !== newMax && hasShopifyVariant) {
            if (oldMax !== null && newMax !== null) {
                // After the sale ends a cut still goes through; a raise does not.
                const delta = saleStockDelta(updatedProgram, newMax - oldMax);
                if (delta !== 0 && !(await adjustProgramInventory(updatedProgram, delta, "capacity-edit", { inRequest: true }))) {
                    warning = "Program updated, but the Shopify inventory adjustment failed. Capacity may be out of sync — check System Status > Link Status.";
                }
            } else if (!isSaleEnded(updatedProgram)) {
                // Null transition (capped <-> uncapped): a relative adjust can't express
                // "start/stop tracking inventory" — that needs an inventory_management
                // flip on the variant, which this PR intentionally doesn't attempt.
                logger.warn(`[SHOPIFY] Program ${updatedProgram.id} maxParticipants transitioned ${oldMax} -> ${newMax} (capped/uncapped); inventory not adjusted automatically.`);
                warning = "Capacity changed between capped and uncapped. Shopify inventory was not updated automatically — run Sync to Shopify or edit inventory directly in Shopify.";
            }
        }

        // Both Shopify variants carry the base price (members pay via a discount code),
        // so only a base-price change is pushed. Only admin/board can change prices.
        const basePriceCents = (p: { nonOrgMemberPriceCents: number | null; orgMemberPriceCents: number | null }) =>
            p.nonOrgMemberPriceCents ?? p.orgMemberPriceCents ?? null;
        const newBase = basePriceCents(updatedProgram);
        if (newBase !== basePriceCents(currentProgram)) {
            const ok = await syncProgramPrice(updatedProgram, newBase);
            if (!ok) {
                const priceWarning = "Program saved, but the Shopify price is out of date — admins have been emailed. Set the price by hand in Shopify on both the public and reserved-seat products.";
                warning = warning ? `${warning} ${priceWarning}` : priceWarning;
            }
        }

        const responseObj: Record<string, unknown> = { success: true, program: updatedProgram };
        if (warning) responseObj.warning = warning;
        // The sweep hid the public product; reopening never re-lists it (automatic changes only reduce visibility).
        if (rearmSale && currentProgram.productHiddenAt) {
            responseObj.notice = "Sale reopened. The public store product stays hidden: re-list it in Shopify by hand if it should sell again.";
        }
        return NextResponse.json(responseObj);
    } catch (error) {
        logger.error("Program update error:", error);
        return apiError("Failed to update program", 500);
    }
});

// A start-date or age-bound edit can leave enrolled people outside the program's
// ages (measured at the start date). The Board is told who; enrollments are
// never changed. Only people who fitted before the edit are named, so a re-save
// doesn't repeat old news.
async function flagEnrollmentsNoLongerFitting(before: Program, after: Program): Promise<void> {
    if (before.minAge === after.minAge && before.maxAge === after.maxAge && before.startAt.getTime() === after.startAt.getTime()) return;
    const rule = (p: Program) => ({ minAge: p.minAge, maxAge: p.maxAge, asOf: p.startAt });
    const enrolled = await prisma.programParticipant.findMany({
        where: { programId: after.id, person: LIVE_PERSON },
        select: { status: true, person: { select: { name: true, dateOfBirth: true, isDeclaredAdult: true } } },
    });
    const misfits = enrolled.flatMap(({ status, person }) => {
        const now = checkProgramAge(person, rule(after));
        return !now.ok && checkProgramAge(person, rule(before)).ok ? [{ name: person.name, status, label: now.label }] : [];
    });
    if (misfits.length === 0) return;

    const rows = misfits.map(m => `<li>${escapeHtml(m.name ?? "Unnamed")}: ${m.label} (${m.status === "ACTIVE" ? "paid" : "not paid yet"})</li>`).join("");
    await emailBoardMembers(
        `Program "${after.name}": ${misfits.length} enrolled no longer fit its ages`,
        `<p>An edit to the dates or age limits of <strong>${escapeHtml(after.name)}</strong> leaves these enrolled people outside its ages at the start date. Nothing was changed; please decide with the program leader and the families.</p><ul>${rows}</ul><p><a href="${config.baseUrl()}/program-ops/programs/${after.id}">Open the program</a></p>`,
        "Program age re-check board alert failed:",
    );
}
