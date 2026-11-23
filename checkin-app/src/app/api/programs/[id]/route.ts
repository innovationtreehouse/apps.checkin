import { NextRequest, NextResponse } from "next/server";
import { VALID_CONTACT_WHERE } from "@/lib/emergencyContacts/valid";
import { logger } from "@/lib/logger";
import { withAuth, authenticateRequest } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { handler, notFound, forbidden, badRequest } from "@/security/handler";
import { getRoute, type Role } from "@/security/core";
import { isActiveOrgMember, isMembershipFeeSettled, isMembershipFeeSettledThrough, programCoverageDate } from "@/lib/orgMembership";
import { apiError } from "@/lib/api-response";
import { ENROLLED_PARTICIPANT } from "@/lib/person/filters";
import { adultPhoneOnly, emailWithheldParticipants, rosterHousehold, rosterPerson, withholdEmail } from "@/lib/person/leaderEmail";
import { householdPaymentViewer } from "@/lib/programs/paymentVisibility";
import { authorizeProgramEdit, updateProgram, type ProgramRefusal } from "@/lib/programs/update";
import { enrollmentClosedBy } from "@/lib/programs/saleState";
import { calculateAge } from "@/lib/time";

// ORDER MATTERS: this export sits ABOVE getProgram so the routeAuthDrift
// guard attributes getProgram's edge-model reads to the nearest preceding
// exported METHOD (this GET) — moving it below silently un-attributes them.
// The registry stripper (security/stripper.ts) is a strict allowlist over each
// model's CLASSIFIED schema fields (see security/generated/classifications.ts,
// generated from /// @sensitivity comments) — it has no channel for a
// viewer-computed scalar that isn't a real Program column, and adding one
// would mean a schema change this feature doesn't get. So viewerIsMember /
// viewerMemberPricingEligible are computed AFTER the registry response comes
// back and merged on top, session callers only, as is enrollmentClosedBy for
// every caller — the registry envelope above
// (roster shaping, per-tier stripping) runs completely untouched first.
// startAt/endAt are 'public' tier, so they always ride in `body` regardless of
// caller privilege; re-authenticating here is the same cheap session read
// authenticateRequest always does, just called a second time.
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
    const res = await getProgram(req, ctx);
    if (res.status !== 200) return res;

    const body = withRosterAges((await res.json()) as ProgramBag);
    const closure = { enrollmentClosedBy: closedBy(body) };

    const auth = await authenticateRequest(req);
    if (auth.type !== 'session') return NextResponse.json({ ...body, ...closure });

    const coverageDate = await programCoverageDate({
        endAt: new Date(body.endAt),
        appliesToYear: body.appliesToYear,
    });
    // viewerIsMember answers "is this household a Treehouse Member" (ACTIVE only);
    // viewerMemberPricingEligible answers the pricing question, which also covers a
    // paid household still awaiting background clearance.
    const [viewerIsMember, viewerMemberPricingEligible] = await Promise.all([
        isActiveOrgMember(auth.user.id),
        isMembershipFeeSettledThrough(auth.user.id, coverageDate),
    ]);
    return NextResponse.json({ ...body, ...closure, viewerIsMember, viewerMemberPricingEligible });
}

type ProgramBody = {
    startAt: string; endAt: string; appliesToYear: number; offSaleAt: string | null;
    enrollmentStatus: 'OPEN' | 'CLOSED'; maxParticipants: number | null; _count?: { participants?: number };
};

type RosterAge = { personId: number; age?: number | null };
type ProgramBag = { Program: ProgramBody & { participants?: { personId: number }[] }; ProgramRosterAge: RosterAge[] };

// Each roster row carries `age` only where the stripper kept it: null is an unknown date of birth.
function withRosterAges({ Program, ProgramRosterAge }: ProgramBag): ProgramBag['Program'] {
    const ages = new Map(ProgramRosterAge.filter(r => 'age' in r).map(r => [r.personId, r.age ?? null]));
    if (!Program.participants) return Program;
    return {
        ...Program,
        participants: Program.participants.map(p => ages.has(p.personId) ? { ...p, age: ages.get(p.personId) } : p),
    };
}

// saleEndedAt is internal-tier and absent here; the off-sale date alone decides, as the claim route does until the sweep runs.
function closedBy(body: ProgramBody) {
    return enrollmentClosedBy({
        enrollmentStatus: body.enrollmentStatus,
        startAt: new Date(body.startAt),
        offSaleAt: body.offSaleAt ? new Date(body.offSaleAt) : null,
        saleEndedAt: null,
        maxParticipants: body.maxParticipants,
    }, body._count?.participants);
}

const ENDPOINT = 'GET /api/programs/[id]';

// The roster says who is enrolled, so only a view holding `roster` (staff, an enrolled household) fetches it.
function viewHoldsRoster(role: Role): boolean {
    return getRoute(ENDPOINT)?.orderedView.find(([r]) => r === role)?.[1].includes('roster') ?? false;
}

const getProgram = handler<{ id: string }>(ENDPOINT, async ({ auth, params, role }) => {
    const programId = parseInt(params.id, 10);
    if (isNaN(programId)) throw badRequest('Invalid program ID');

    // Explicit select, not include: whole rows would ship every pii/personal
    // column a lead mentor's view happens to grant (googleId, dateOfBirth,
    // allergies, the payment-plan flags) plus any column added later. The id /
    // programId / personId / householdId keys below are ROW_SCOPE_KEYs — drop
    // one and scopesHeld() fails closed and strips the row for the very roles
    // this route serves (see the emergencyContacts note).
    const [program, rosterBag] = await Promise.all([
        prisma.program.findUnique({
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
                // Spots remaining on the public catalog page: a count, never the rows.
                _count: { select: { participants: { where: ENROLLED_PARTICIPANT }, volunteers: true } },
            },
        }),
        viewHoldsRoster(role)
            ? prisma.program.findUnique({
                  where: { id: programId },
                  select: {
                      volunteers: {
                          select: {
                              programId: true,
                              personId: true,
                              isCore: true,
                              person: { select: { id: true, name: true, email: true } },
                          },
                      },
                      participants: {
                          where: ENROLLED_PARTICIPANT,
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
                                      phone: true,
                                      dateOfBirth: true,
                                      isDeclaredAdult: true,
                                      householdId: true,
                                      household: {
                                          select: {
                                              id: true,
                                              // The family's parents, for the roster's "call someone" band.
                                              // householdId and isHouseholdLead are BOTH scope keys for the
                                              // Person their_program_households binding: drop either and a
                                              // lead resolves no scope, so name/email/phone strip away.
                                              householdMembers: {
                                                  where: { isHouseholdLead: true },
                                                  orderBy: { id: "asc" },
                                                  select: { id: true, householdId: true, isHouseholdLead: true, name: true, email: true, phone: true },
                                              },
                                              emergencyContacts: {
                                                  where: VALID_CONTACT_WHERE,
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
                  },
              })
            : null,
    ]);

    if (!program) throw notFound('Program not found');

    const isSessionUser = auth.type === 'session';
    const sessionUser = isSessionUser ? auth.user : undefined;
    const isSysAdminOrBoard = !!(sessionUser?.isSysadmin || sessionUser?.isBoardMember);
    const isLeadMentor = !!sessionUser && sessionUser.id === program.leadMentorId;
    const isCoreVolunteer = !!sessionUser && !!rosterBag?.volunteers.some(v => v.personId === sessionUser.id && v.isCore);
    // Finance reads the roster to enroll places paid outside the store.
    const isPrivileged = isSysAdminOrBoard || !!sessionUser?.isFinance || isLeadMentor || isCoreVolunteer;

    // A members-only program is hidden unless its leader opted it into the public
    // catalogue (publiclyVisible) — then anyone may view its detail, but the
    // enrollment route still gates joining on a settled membership. The membership fee is settled,
    // not "is a member": a paid household awaiting background clearance is admitted.
    if (program.orgMemberOnly && !program.publiclyVisible && !isPrivileged) {
        if (!sessionUser) throw notFound('Program not found');
        const membershipFeeSettled = await isMembershipFeeSettled(sessionUser.id);
        if (!membershipFeeSettled) throw forbidden('Forbidden: Member-Only Program');
    }

    // Anonymous and non-enrolled callers get the catalog fields and counts only.
    if (!rosterBag) return { Program: program, ProgramRosterAge: [] };

    const viewerIsLeader = (isLeadMentor || isCoreVolunteer) && !isSysAdminOrBoard;
    const emailWithheldFrom = emailWithheldParticipants(rosterBag.participants, viewerIsLeader);
    const ages = rosterBag.participants.map(p => ({
        personId: p.personId,
        age: p.person.dateOfBirth ? calculateAge(p.person.dateOfBirth, program.startAt) : null,
    }));
    const roster = rosterBag.participants.map(p => ({
        ...p,
        person: { ...rosterPerson(adultPhoneOnly(p.person, program.startAt), viewerIsLeader), household: rosterHousehold(p.person.household, emailWithheldFrom) },
    }));

    if (isPrivileged) {
        const volunteers = rosterBag.volunteers.map(v => ({ ...v, person: withholdEmail(v.person, emailWithheldFrom) }));
        return { Program: { ...program, volunteers, participants: roster }, ProgramRosterAge: ages };
    }

    // The enrolled household's view. Payment status (status = paid vs not paid yet)
    // is staff's, plus a household lead's for their own household. The stripper
    // can't express "own household", so other rows are dropped of it here —
    // including every row for a youth.
    // The household is read from the DB, not the session, so a move applies at once.
    const viewer = sessionUser ? await householdPaymentViewer(sessionUser.id) : null;
    const seesPayment = (p: { personId: number; person: { householdId: number } | null }) => !!viewer && (
        p.personId === sessionUser?.id ||
        p.person?.householdId === viewer.householdId
    );
    const participants = roster.map(({ status, pendingSince, ...row }) =>
        seesPayment(row) ? { ...row, status, pendingSince } : row
    );
    return { Program: { ...program, volunteers: rosterBag.volunteers, participants }, ProgramRosterAge: ages };
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
