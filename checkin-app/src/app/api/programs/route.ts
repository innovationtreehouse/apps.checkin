import { NextResponse } from "next/server";
import { withAuth, getOptionalSessionUser } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { sendNotification } from "@/lib/notifications";
import { createClaimantProduct, createShopifySingleVariantProgram, programProductHandle } from "@/lib/shopify/products";
import { isProgramStoreClosed } from "@/lib/programs/storeClosed";
import { adjustProgramInventory } from "@/lib/shopify/stock";
import { logBackendError, logger } from "@/lib/logger";
import { isMembershipFeeSettled } from "@/lib/orgMembership";
import { config } from "@/lib/config";
import { dollarsToCentsOrNull } from "@checkin/money";
import { apiError } from "@/lib/api-response";
import { ENROLLED_PARTICIPANT } from "@/lib/person/filters";
import { staleWhileRevalidate } from "@/lib/staleCache";
import { validateProgramAgeBounds, isLeaderAgeEligible } from "@/lib/programAge";
import { recordSelfGrantRefusal } from "@/lib/membership/selfGrantGuard";
import { hasHouseholdConflict } from "@/lib/conflictOfInterest";
import { parseProgramName, resolveProgramYear } from "@/lib/programs/update";
import { leaderEmailRefusal, programLeaderIneligibility } from "@/lib/programs/leaderEligibility";
import { isProgramNameTaken, PROGRAM_NAME_TAKEN, programNameFields } from "@/lib/programs/nameKey";
import { enrollmentClosedBy } from "@/lib/programs/saleState";
import { orgToday } from "@/lib/appSettings";
import { isLiveHousehold } from "@/lib/household/archived";
import { ARCHIVED_HOUSEHOLD_REFUSAL, lockLiveHouseholdsOf } from "@/lib/household/archiveGuard";
import { ServiceError } from "@checkin/component-kit";
import { personActor, recordAudit } from "@/lib/auditActor";
import { openPersonAgreementOnEngage } from "@/lib/membership/personAgreementTriggers";


// Public catalog projection: every Program column whose `/// @sensitivity:` tier
// is `public` per src/security/generated/classifications.ts, in schema order.
// Deliberately omits `leadMentorNotificationSettings` (tier `personal`) — GET is
// anonymous-readable and its rows are shared through a 60s cache, so a bare
// findMany shipped that column to every signed-out visitor. Keep this in sync
// with the classifications Program block when columns are added.
const PUBLIC_PROGRAM_SELECT = {
    id: true,
    name: true,
    leadMentorId: true,
    startAt: true,
    endAt: true,
    appliesToYear: true,
    phase: true,
    enrollmentStatus: true,
    offSaleAt: true,
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
    claimantShopifyProductId: true,
    claimantShopifyVariantId: true,
} as const;

// GET is the PUBLIC program catalog — anonymous callers legitimately get the
// non-draft list minus the members-only-and-hidden programs (asserted by
// programsAPI.integration.test.ts), so it can't move to withAuth (which 401s
// anonymous). getOptionalSessionUser applies the shared denied-household gate: a
// denied member is locked out of the whole app, so it collapses to undefined
// (anonymous) — they see only the public list and never the hidden members-only
// programs isMembershipFeeSettled would otherwise reveal.
export async function GET(req: Request) {
    const user = await getOptionalSessionUser(req);

    // ops-stg access gate: getOptionalSessionUser collapses a gate-rejected caller
    // (denied household, or on staging a non-org/non-canAccessStaging caller) to
    // `undefined` — the SAME shape as a genuinely anonymous visitor, which is the
    // intended "public catalog" happy path in prod/dev. On staging this route
    // serves the full prod-copied catalog (names, dates, prices, Shopify ids, live
    // enrollment counts), so without this explicit check an anonymous curl reads it
    // straight through the "public visitor" branch below. See
    // tests/security/routeAuthDrift.test.ts rule 4, which fails any future
    // getOptionalSessionUser caller that forgets this.
    if (config.isStaging() && !user) {
        return apiError("Unauthorized", 401);
    }

    try {
        const { searchParams } = new URL(req.url);
        const activeOnly = searchParams.get("active") === "true";

        // Determine if the user is allowed to see hidden members-only programs
        let canSeeMembersOnly = false;

        if (user) {
            if (user.isSysadmin || user.isBoardMember) {
                canSeeMembersOnly = true;
            } else {
                // The membership fee is settled, not "is a member": a paid household awaiting
                // background clearance sees members-only programs too.
                canSeeMembersOnly = await isMembershipFeeSettled(user.id);
            }
        }

        const andClauses: Record<string, unknown>[] = [];

        if (activeOnly) {
            andClauses.push({ endAt: { gte: new Date() } });
        }

        // A members-only program is hidden from non-members unless its leader opted
        // it into the public catalogue (publiclyVisible) — enrollment stays gated.
        if (!canSeeMembersOnly) {
            andClauses.push({ OR: [{ orgMemberOnly: false }, { publiclyVisible: true }] });
        }

        let canSeeDrafts = false;
        let userId: number | undefined;
        if (user) {
            userId = user.id;
            if (user.isSysadmin || user.isBoardMember) {
                canSeeDrafts = true;
            }
        }

        if (!canSeeDrafts) {
            if (userId && !isNaN(userId)) {
                andClauses.push({
                    OR: [
                        { phase: { not: 'PLANNING' } },
                        { leadMentorId: userId }
                    ]
                });
            } else {
                andClauses.push({ phase: { not: 'PLANNING' } });
            }
        }

        const fetchPrograms = () => prisma.program.findMany({
            where: andClauses.length > 0 ? { AND: andClauses } : undefined,
            orderBy: { startAt: 'asc' },
            select: {
                ...PUBLIC_PROGRAM_SELECT,
                _count: {
                    select: {
                        participants: { where: ENROLLED_PARTICIPANT },
                        volunteers: true,
                        events: true
                    }
                }
            }
        });

        // ANONYMOUS-ONLY cache (lib/staleCache): the where-clause is identical for
        // every signed-out caller, so one entry serves them all — and a session
        // (draft/mentor visibility varies the payload) never touches it, which is
        // what makes the cache leak-proof by construction.
        //
        // ONLY the static rows are cached — never enrollment figures. The counts
        // come from a separate LIVE query raced against a short timeout: merged in
        // when the database answers, omitted entirely when it doesn't (resume).
        // Stale program names are fine; stale "spots taken" numbers are not.
        if (!userId && !canSeeDrafts) {
            const { value: staticRows } = await staleWhileRevalidate(
                "programs:public:static",
                60_000,
                () => prisma.program.findMany({
                    where: andClauses.length > 0 ? { AND: andClauses } : undefined,
                    orderBy: { startAt: 'asc' },
                    select: PUBLIC_PROGRAM_SELECT,
                }),
            );
            const counts = await Promise.race([
                prisma.program.findMany({
                    where: { id: { in: staticRows.map((prg) => prg.id) } },
                    select: { id: true, _count: { select: { participants: { where: ENROLLED_PARTICIPANT }, volunteers: true, events: true } } },
                }).catch(() => null),
                new Promise<null>((resolve) => { const t = setTimeout(() => resolve(null), 2_500); t.unref?.(); }),
            ]);
            const countById = new Map((counts ?? []).map((c) => [c.id, c._count]));
            const today = await orgToday();
            return NextResponse.json(staticRows.map((prg) => withClosedBy({ ...prg, _count: countById.get(prg.id) }, today)));
        }
        const today = await orgToday();
        return NextResponse.json((await fetchPrograms()).map((prg) => withClosedBy(prg, today)));
    } catch (error) {
        await logBackendError(error, "GET /api/programs");
        return apiError("Failed to fetch programs", 500);
    }
}

// saleEndedAt is internal-tier and not selected; the off-sale date alone decides, as the claim route does until the sweep runs.
function withClosedBy<P extends Omit<Parameters<typeof enrollmentClosedBy>[0], 'saleEndedAt'> & { _count?: { participants: number } }>(prg: P, today: Date) {
    return { ...prg, enrollmentClosedBy: enrollmentClosedBy({ ...prg, saleEndedAt: null }, prg._count?.participants, today) };
}

// Creating a program names its lead, and only the Board assigns one.
export const POST = withAuth({ roles: ['isBoardMember'] }, async (req, auth) => {
    if (auth.type !== 'session') return apiError("Unauthorized", 401);

    // Hoisted so the catch can name an orphaned Shopify product (created, but its ids not saved) for manual cleanup.
    let shopifyData: { shopifyProductId: string, shopifyVariantId: string } | null = null;
    let claimantData: { claimantShopifyProductId: string, claimantShopifyVariantId: string } | null = null;

    try {
        const body = await req.json();
        const { leadMentorId, startAt, endAt, appliesToYear, orgMemberOnly, publiclyVisible, minAge, maxAge, memberPrice, nonMemberPrice, maxParticipants } = body;

        const parsedName = parseProgramName(body.name ?? "");
        if (!parsedName.ok) return apiError(parsedName.message, 400);
        const { name } = parsedName;

        if (!leadMentorId) {
            return apiError("Program Leader is required", 400);
        }

        const mentorId = parseInt(leadMentorId, 10);
        const mentor = await prisma.person.findUnique({
            where: { id: mentorId },
            select: { dateOfBirth: true, isDeclaredAdult: true, householdId: true, lastBackgroundCheck: true, email: true },
        });
        if (!mentor) {
            return apiError("Program Leader not found", 400);
        }
        if (!isLeaderAgeEligible(mentor, await orgToday())) {
            return apiError("Program Leader must be at least 23 years old", 400);
        }
        const noEmail = leaderEmailRefusal(mentor);
        if (noEmail) return apiError(noEmail, 400);
        // Nobody names themself or their household as a program's leader (Ethics Policy III.5).
        if (mentorId === auth.user.id || await hasHouseholdConflict(prisma, auth.user.id, mentor.householdId)) {
            await recordSelfGrantRefusal(prisma, {
                actorId: auth.user.id,
                affectedEntityId: mentorId,
                newData: { reason: "own_household", table: "Program", subject: { personId: mentorId, householdId: mentor.householdId }, attempted: { name, leadMentorId: mentorId } },
            });
            return apiError("Forbidden: You cannot make yourself or a member of your household a program lead", 403);
        }
        // Checked before any store product exists; the create re-checks under the household lock.
        if (!(await isLiveHousehold(mentor.householdId))) {
            return apiError(ARCHIVED_HOUSEHOLD_REFUSAL, 409);
        }

        if (!startAt) {
            return apiError("Start date is required", 400);
        }
        if (!endAt) {
            return apiError("End date is required", 400);
        }
        const startDate = new Date(startAt);
        const endDate = new Date(endAt);
        if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
            return apiError("Invalid start or end date", 400);
        }
        if (startDate > endDate) {
            return apiError("Start date must be on or before the end date", 400);
        }
        const year = await resolveProgramYear({
            startAt: startDate,
            endAt: endDate,
            supplied: appliesToYear,
            current: null,
            isBoardMember: auth.user.isBoardMember,
        });
        if (!year.ok) return apiError(year.message, year.refusal === "forbidden" ? 403 : 400);
        const ineligible = await programLeaderIneligibility(mentorId, mentor, year.appliesToYear);
        if (ineligible) return apiError(ineligible, 400);

        const maxPart = maxParticipants != null ? parseInt(maxParticipants, 10) : null;
        if (maxPart == null || isNaN(maxPart) || maxPart < 1) {
            return apiError("Max participants is required and must be at least 1", 400);
        }

        const ageErr = validateProgramAgeBounds(minAge, maxAge);
        if (ageErr) {
            return apiError(ageErr, 400);
        }

        // Client sends a raw dollar string; tolerate a number too. Convert to cents here.
        const mPrice = dollarsToCentsOrNull(memberPrice != null ? String(memberPrice) : undefined);
        const nmPrice = dollarsToCentsOrNull(nonMemberPrice != null ? String(nonMemberPrice) : undefined);

        // Single-pool model: ONE Shopify variant, priced at the base/non-member
        // rate; member pricing is a checkout-time discount code, not a second
        // variant. The member price is never sent to the store: with no full
        // price there is no store product (sync-shopify mints it once one is set).
        const basePriceCents = nmPrice;

        // The row commits before any store product exists, so a create refused as a duplicate name leaves nothing in Shopify.
        const createdProgram = await prisma.$transaction(async (tx) => {
            await lockLiveHouseholdsOf(tx, [mentorId]);
            const created = await tx.program.create({
                data: {
                    ...programNameFields(name),
                    leadMentorId: mentorId,
                    startAt: startDate,
                    endAt: endDate,
                    appliesToYear: year.appliesToYear,
                    orgMemberOnly: orgMemberOnly || false,
                    // publiclyVisible only has meaning for a members-only program; a
                    // public one is already visible. Clamp so the nonsense state
                    // (not members-only, yet flagged publiclyVisible) can't be stored.
                    publiclyVisible: (orgMemberOnly || false) && (publiclyVisible || false),
                    minAge: minAge ?? null,
                    maxAge: maxAge ?? null,
                    orgMemberPriceCents: mPrice,
                    nonOrgMemberPriceCents: nmPrice,
                    maxParticipants: maxPart,
                }
            });
            await recordAudit(tx, personActor(auth.user.id), {
                action: 'CREATE',
                tableName: 'Program',
                affectedEntityId: created.id,
                newData: created
            });
            return created;
        });
        await openPersonAgreementOnEngage(mentorId);

        // Stable handles, so a Sync to Shopify run after a failure here finds these products instead of minting twice.
        let newProgram = createdProgram;
        if (basePriceCents && basePriceCents > 0) {
            shopifyData = await createShopifySingleVariantProgram(name, basePriceCents, maxPart, programProductHandle(createdProgram, "public"), !(await isProgramStoreClosed()));
            // Without it checkout falls back to the public variant; the board can mint it later via sync-shopify.
            if (shopifyData) claimantData = await createClaimantProduct(name, basePriceCents, programProductHandle(createdProgram, "claimant"));
            if (shopifyData) {
                const ids = { ...shopifyData, ...claimantData };
                newProgram = await prisma.$transaction(async (tx) => {
                    const updated = await tx.program.update({ where: { id: createdProgram.id }, data: ids });
                    await recordAudit(tx, personActor(auth.user.id), {
                        action: 'EDIT',
                        tableName: 'Program',
                        affectedEntityId: updated.id,
                        oldData: createdProgram,
                        newData: updated,
                    });
                    return updated;
                });
            }
        }

        if (newProgram.leadMentorId) {
            await sendNotification(newProgram.leadMentorId, 'PROGRAM_ASSIGNMENT', { programName: newProgram.name, programId: newProgram.id });
        }

        // A new capped variant starts sold out (0 available); lift it to capacity.
        const stockOk = !shopifyData || await adjustProgramInventory(newProgram, maxPart, "initial-stock", { inRequest: true });

        const responseObj: Record<string, unknown> = { success: true, program: newProgram };
        if (((mPrice && mPrice > 0) || (nmPrice && nmPrice > 0)) && !shopifyData) {
            responseObj.warning = "Program created, but Shopify integration failed or is not configured. Payment links will not work.";
        } else if (shopifyData && !claimantData) {
            responseObj.warning = "Program created, but its Shopify reserved-seat product failed, so payment links will not work. Run Sync to Shopify to retry.";
        } else if (!stockOk) {
            responseObj.warning = "Program created, but setting its Shopify stock failed, so it may show as sold out. Check System Status > Link Status.";
        }

        return NextResponse.json(responseObj);
    } catch (error: unknown) {
        if (isProgramNameTaken(error)) return apiError(PROGRAM_NAME_TAKEN, 409);
        if (shopifyData?.shopifyProductId) {
            logger.error("[Shopify] Orphaned product after program DB write failed, manual cleanup needed:", shopifyData.shopifyProductId);
        }
        if (claimantData?.claimantShopifyProductId) {
            logger.error("[Shopify] Orphaned claimant product after program DB write failed, manual cleanup needed:", claimantData.claimantShopifyProductId);
        }
        if (error instanceof ServiceError) return apiError(error.message, error.status);
        await logBackendError(error, "POST /api/programs");
        return apiError("Failed to create program", 500);
    }
});
