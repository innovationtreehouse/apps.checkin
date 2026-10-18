import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { withAuth, authenticateRequest } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { handler, notFound, forbidden, badRequest } from "@/security/handler";
import { isActiveOrgMember, isMembershipFeeSettled, isMembershipFeeSettledThrough, programCoverageDate } from "@/lib/orgMembership";
import { apiError } from "@/lib/api-response";
import { LIVE_PERSON, ENROLLED_PARTICIPANT } from "@/lib/person/filters";
import { householdPaymentViewer } from "@/lib/programs/paymentVisibility";
import { authorizeProgramEdit, updateProgram, type ProgramRefusal } from "@/lib/programs/update";

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

    const body = (await res.json()) as { startAt: string; endAt: string; appliesToYear: number | null };
    const coverageDate = await programCoverageDate({
        endAt: new Date(body.endAt),
        appliesToYear: body.appliesToYear ?? null,
    });
    // viewerIsMember answers "is this household a Treehouse Member" (ACTIVE only);
    // viewerMemberPricingEligible answers the pricing question, which also covers a
    // paid household still awaiting background clearance.
    const [viewerIsMember, viewerMemberPricingEligible] = await Promise.all([
        isActiveOrgMember(auth.user.id),
        isMembershipFeeSettledThrough(auth.user.id, coverageDate),
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
            appliesToYear: true,
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
                where: { person: LIVE_PERSON, ...ENROLLED_PARTICIPANT },
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
            _count: { select: { participants: { where: { person: LIVE_PERSON, ...ENROLLED_PARTICIPANT } }, volunteers: { where: { person: LIVE_PERSON } } } },
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
    // enrollment route still gates joining on a settled membership. The membership fee is settled,
    // not "is a member": a paid household awaiting background clearance is admitted.
    if (program.orgMemberOnly && !program.publiclyVisible && !isPrivileged) {
        if (!sessionUser) throw notFound('Program not found');
        const membershipFeeSettled = await isMembershipFeeSettled(sessionUser.id);
        if (!membershipFeeSettled) throw forbidden('Forbidden: Member-Only Program');
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

        const access = await authorizeProgramEdit(programId, auth.user);
        if (!access.ok) return apiError(access.message, REFUSAL_STATUS[access.refusal]);

        const result = await updateProgram(access.program, await req.json(), auth.user);
        if (!result.ok) return apiError(result.message, REFUSAL_STATUS[result.refusal]);

        const responseObj: Record<string, unknown> = { success: true, program: result.program };
        if (result.warning) responseObj.warning = result.warning;
        if (result.notice) responseObj.notice = result.notice;
        return NextResponse.json(responseObj);
    } catch (error) {
        logger.error("Program update error:", error);
        return apiError("Failed to update program", 500);
    }
});

const REFUSAL_STATUS: Record<ProgramRefusal, number> = {
    invalid: 400,
    forbidden: 403,
    not_found: 404,
    conflict: 409,
};
