import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import prisma from "@/lib/prisma";
import { withAuth } from "@/lib/auth";
import { apiError } from "@/lib/api-response";
import { hasHouseholdConflict } from "@/lib/conflictOfInterest";
import { renewalSeasonWindow, membershipYearCycle, coveredThrough, bgValidUntilBoundary, grantRenewalPayment, MAX_DATE } from "@/lib/membership/renewal";
import { grantableRenewalWhere, settledThisCycleWhere } from "@/lib/membership/lifecycle";
import { PaymentError } from "@/lib/membership/payment";
import { grantCurrentYear } from "@/lib/membership/grant";
import { ensureHouseholdMembership, setHouseholdStatus } from "@/lib/membership/householdStatus";
import { personActor } from "@/lib/auditActor";
import { LIVE_PERSON } from "@/lib/person/filters";
import { searchId } from "@/lib/searchId";

export const dynamic = 'force-dynamic';

// Emergency contacts are their own entity now; the admin editor still works in
// terms of a single primary contact, so map the household's primary valid contact
// back onto the flat emergencyContactName/Phone shape the client expects. Include
// it inline (below) with this where/order so Prisma infers the result type.
const PRIMARY_CONTACT_WHERE = { conflictParticipantId: null, name: { not: "" }, phone: { not: "" } };

// "Valid until" is DERIVED, never stored: coveredThrough over the live membership
// year — the boundary closing it when the household settled for it, else the one
// that opened it. Deriving keeps it consistent with everything else the boundary
// drives (renewal sweep, badge years, pricing) with nothing to hand-update.
function withFlatContact<T extends { emergencyContacts: { name: string; phone: string }[] }>(h: T) {
    const primary = h.emergencyContacts[0] ?? null;
    const { emergencyContacts: _drop, ...rest } = h;
    void _drop;
    return { ...rest, emergencyContactName: primary?.name ?? null, emergencyContactPhone: primary?.phone ?? null };
}

export const GET = withAuth(
    { roles: ['isSysadmin', 'isBoardMember'] },
    async (req) => {
        try {
            const url = new URL(req.url);
            const id = url.searchParams.get('id');
            const q = url.searchParams.get('q') || '';

            if (id) {
                const household = await prisma.household.findUnique({
                    where: { id: parseInt(id) },
                    include: {
                        householdMembers: {
                            where: LIVE_PERSON,
                            select: {
                                id: true, name: true, email: true, isHouseholdLead: true, lastBackgroundCheck: true,
                                // dateOfBirth: the Edit Info modal excludes youth from the
                                // "Make lead" control (mirrors membership-audit/broken).
                                dateOfBirth: true,
                                // Program enrollments for the household detail view. Extra field the
                                // Edit Info modal (same endpoint) simply ignores.
                                programParticipants: {
                                    select: { status: true, program: { select: { id: true, name: true } } },
                                    orderBy: { program: { name: "asc" } },
                                },
                            }
                        },
                        orgMembership: true,
                        emergencyContacts: {
                            where: PRIMARY_CONTACT_WHERE,
                            orderBy: [{ priority: "asc" }, { id: "asc" }],
                            select: { name: true, phone: true },
                            take: 1,
                        },
                    }
                });
                if (!household) return NextResponse.json({ household: null });
                const householdLeads = household.householdMembers.filter(p => p.isHouseholdLead).map(p => ({ personId: p.id }));

                // ONE settings read serves the derived valid-until and the BG "valid until" calc below.
                const settings = await prisma.boardSettings.findUnique({
                    where: { id: 1 }, select: { orgMembershipYearBoundary: true, bgRecheckMonths: true },
                });
                const detailCycle = settings?.orgMembershipYearBoundary
                    ? membershipYearCycle(settings.orgMembershipYearBoundary, new Date())
                    : null;
                // "Settled for the live year" = ANY dues-paid process (settledThisCycleWhere)
                // stamped since the year's window opened — a family that JOINS in-window
                // buys the coming year exactly as a renewer does, so INITIAL counts too.
                // ARCHIVED never completed payment and does not extend the horizon (the
                // sweep alone treats it as handled). Same test the list branch and
                // membershipValidThrough use. No boundary ⇒ "never" (matches nothing).
                const detailSettled = household.orgMembership
                    ? (await prisma.orgMembershipProcess.findFirst({
                          where: {
                              orgMembershipId: household.orgMembership.id,
                              ...settledThisCycleWhere(detailCycle?.settledSince ?? MAX_DATE),
                          },
                          select: { id: true },
                      })) !== null
                    : false;
                const bgSettings = {
                    orgMembershipYearBoundary: settings?.orgMembershipYearBoundary ?? null,
                    bgRecheckMonths: settings?.bgRecheckMonths ?? 0,
                };
                // Per member — every member with a passed check (leads AND non-lead PERSON_BG
                // subjects alike); null when no check on file / policy unset.
                const membersWithBg = household.householdMembers.map((m) => ({
                    ...m,
                    bgValidUntil: bgValidUntilBoundary(m.lastBackgroundCheck, bgSettings),
                }));
                // Household level — the LATER lastBackgroundCheck among household leads who
                // passed (either lead's valid check covers the household).
                const latestLeadBg = household.householdMembers
                    .filter((m) => m.isHouseholdLead && m.lastBackgroundCheck)
                    .reduce<Date | null>((acc, m) => (!acc || m.lastBackgroundCheck! > acc ? m.lastBackgroundCheck! : acc), null);
                const householdBgValidUntil = bgValidUntilBoundary(latestLeadBg, bgSettings);

                return NextResponse.json({
                    household: { ...withFlatContact(household), householdMembers: membersWithBg, householdLeads, bgValidUntil: householdBgValidUntil },
                    validUntil: household.orgMembership?.status === "ACTIVE" && detailCycle ? coveredThrough(detailCycle, detailSettled) : null,
                });
            }

            // A bare number searches ids too — the household's own, and any member's,
            // since both are printed in the ops tables and pasted back into this box.
            const idQuery = searchId(q);
            const whereClause = q ? {
                OR: [
                    { name: { contains: q, mode: 'insensitive' as const } },
                    { householdMembers: { some: { name: { contains: q, mode: 'insensitive' as const } } } },
                    { householdMembers: { some: { email: { contains: q, mode: 'insensitive' as const } } } },
                    ...(idQuery !== null ? [
                        { id: idQuery },
                        { householdMembers: { some: { id: idQuery } } },
                    ] : []),
                ]
            } : {};

            // Renewal season drives the coming-year grant button; the live cycle drives
            // the settled arm of the process include below (no boundary ⇒ matches nothing).
            const window = await renewalSeasonWindow(new Date());
            const settings = await prisma.boardSettings.findUnique({ where: { id: 1 } });
            const cycle = settings?.orgMembershipYearBoundary
                ? membershipYearCycle(settings.orgMembershipYearBoundary, new Date())
                : null;

            const households = await prisma.household.findMany({
                where: whereClause,
                include: {
                    householdMembers: {
                        where: LIVE_PERSON,
                        // isHouseholdLead + lastBackgroundCheck drive the household-level "BG valid
                        // until" below. Board-only endpoint; lastBackgroundCheck rides along in the
                        // JSON at the same trust level as the rest of the row.
                        select: { id: true, name: true, email: true, isBoardMember: true, emailUndeliverableAt: true, isHouseholdLead: true, lastBackgroundCheck: true }
                    },
                    // ONE probe serves both flags computed below, from the shared lifecycle
                    // definitions: grantableRenewalWhere (payable renewal → grantability)
                    // and settledThisCycleWhere (ANY dues-paid process — INITIAL or
                    // RENEWAL — stamped since the live year's window opened → settled for
                    // it, the same test membershipValidThrough uses; ARCHIVED never paid,
                    // so it is the sweep's business only). No boundary ⇒ "never" (matches
                    // no row), keeping one query shape and one inferred type.
                    // orgMembership's own scalars (status, memberSince) still ride along.
                    orgMembership: {
                        include: {
                            processes: {
                                where: {
                                    OR: [
                                        grantableRenewalWhere,
                                        settledThisCycleWhere(cycle?.settledSince ?? MAX_DATE),
                                    ],
                                },
                                select: { id: true, status: true },
                            },
                        },
                    },
                    emergencyContacts: {
                        where: PRIMARY_CONTACT_WHERE,
                        orderBy: [{ priority: "asc" }, { id: "asc" }],
                        select: { name: true, phone: true },
                        take: 1,
                    },
                },
                orderBy: {
                    id: 'desc'
                },
                ...(q && { take: 20 })
            });

            const recheckMonths = settings?.bgRecheckMonths ?? 0;
            const bgSettings = { orgMembershipYearBoundary: settings?.orgMembershipYearBoundary ?? null, bgRecheckMonths: recheckMonths };

            const withGrantable = households.map((h) => {
                // Split the single OR probe by status: PENDING_PAYMENT = grantable renewal
                // (grantableRenewalWhere — kind RENEWAL, so an in-flight INITIAL at
                // payment never reads as grantable); any other row is a dues-paid process
                // of EITHER kind = the live year is settled (settledThisCycleWhere:
                // finished renewal, admin override, or a family that joined inside
                // the window).
                const { processes = [], ...orgMembership } = h.orgMembership ?? {};
                const renewalGrantable = processes.some((p) => p.status === "PENDING_PAYMENT");
                const settledForComingYear = processes.some((p) => p.status !== "PENDING_PAYMENT");
                // Household-level BG "valid until" — later lastBackgroundCheck among leads
                // who passed; no per-member values in the list response.
                const latestLeadBg = h.householdMembers
                    .filter((m) => m.isHouseholdLead && m.lastBackgroundCheck)
                    .reduce<Date | null>((acc, m) => (!acc || m.lastBackgroundCheck! > acc ? m.lastBackgroundCheck! : acc), null);
                const bgValidUntil = bgValidUntilBoundary(latestLeadBg, bgSettings);
                return {
                    ...withFlatContact(h),
                    orgMembership: h.orgMembership ? orgMembership : null,
                    renewalGrantable,
                    settledForComingYear,
                    bgValidUntil,
                    validUntil: h.orgMembership?.status === "ACTIVE" && cycle ? coveredThrough(cycle, settledForComingYear) : null,
                };
            });

            return NextResponse.json({
                households: withGrantable,
                renewalSeason: window !== null,
            });
        } catch (error) {
            logger.error("Failed to fetch households:", error);
            return apiError("Failed to fetch households", 500);
        }
    }
);

export const POST = withAuth(
    { roles: ['isSysadmin', 'isBoardMember'] },
    async (req, auth) => {
        try {
            if (auth.type !== "session") return apiError("Unauthorized", 401);
            const body = await req.json();
            const { householdId, active, deny, comingYear, reason } = body;

            if (!householdId) {
                return apiError("Household ID is required", 400);
            }

            // Every household-status action here — deny, restore, grant, revoke — is refused
            // for the actor's own household. No role bypasses it.
            if (await hasHouseholdConflict(prisma, auth.user.id, householdId)) {
                return apiError("You cannot change your own household's membership — someone outside your household must.", 403);
            }
            const actor = personActor(auth.user.id);
            const trimmedReason = typeof reason === "string" ? reason.trim() : "";

            // Deny / restore — a separate legal act from grant/revoke. Denying blocks login for
            // every member of the household (enforced in the auth layer). Restore is "undeny":
            // DENIED → NONE only.
            if (typeof deny === "boolean") {
                if (deny) {
                    // Two separate legal actions → two separate software actions: a household
                    // containing a board member cannot be denied. Remove the board role first.
                    // Enforced server-side; the UI's disabled button is only a courtesy.
                    const boardMemberInHousehold = await prisma.person.findFirst({
                        where: { householdId, isBoardMember: true, ...LIVE_PERSON },
                        select: { id: true }
                    });
                    if (boardMemberInHousehold) {
                        return apiError("This household includes a board member. Remove the board role before denying membership.", 409);
                    }
                }
                const membership = await ensureHouseholdMembership(prisma, householdId);
                const applied = await setHouseholdStatus(prisma, membership.id, deny
                    ? { from: ["NONE", "ACTIVE", "REVOKED"], to: "DENIED", actor, reason: trimmedReason || "board deny" }
                    : { from: ["DENIED"], to: "NONE", actor, reason: trimmedReason || "board restore" });
                if (!applied) {
                    return apiError(deny ? "This household is already denied." : "Only a denied household can be restored.", 409);
                }
                return NextResponse.json({ success: true, membership: await prisma.orgMembership.findUnique({ where: { id: membership.id } }) });
            }

            // Grants pay an application (money only); neither sets the household's status.
            if (comingYear || active) {
                if (!trimmedReason) return apiError("A reason is required to certify a payment", 400);
                try {
                    const grantActor = { actorId: auth.user.id, reason: trimmedReason };
                    if (comingYear) {
                        return NextResponse.json({ success: true, process: await grantRenewalPayment(householdId, grantActor) });
                    }
                    const result = await grantCurrentYear(householdId, grantActor);
                    return NextResponse.json({
                        success: true,
                        ...result,
                        message: result.paid
                            ? (result.process.status === "ACTIVE" ? "Granted: the membership is active." : "Granted: the membership activates once the background check clears.")
                            : "Application opened: the family completes it, then grant again once it reaches payment.",
                    });
                } catch (e) {
                    if (e instanceof PaymentError) {
                        const status = e.code === "forbidden" ? 403 : e.code === "not_found" ? 404 : 409;
                        return apiError(e.message, status);
                    }
                    throw e; // unexpected → outer catch → 500
                }
            }

            // Revoke: only a household that is still ACTIVE at write time.
            const existingMembership = await prisma.orgMembership.findUnique({ where: { householdId } });
            if (existingMembership && await setHouseholdStatus(prisma, existingMembership.id, { from: ["ACTIVE"], to: "REVOKED", actor, reason: trimmedReason || "board revoke" })) {
                return NextResponse.json({ success: true, message: "Membership deactivated" });
            }

            return NextResponse.json({ success: true, message: "No change needed" });
        } catch (error) {
            logger.error("Failed to update household membership:", error);
            return apiError("Failed to update membership", 500);
        }
    }
);
