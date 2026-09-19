import { NextResponse } from "next/server";
import { withAuth, getOptionalSessionUser } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { sendNotification } from "@/lib/notifications";
import { createShopifySingleVariantProgram } from "@/lib/shopify";
import { logBackendError, logger } from "@/lib/logger";
import { isDuesSettled } from "@/lib/orgMembership";
import { config } from "@/lib/config";
import { dollarsToCentsOrNull } from "@inventory/money";
import { apiError } from "@/lib/api-response";
import { LIVE_PERSON } from "@/lib/person/filters";
import { staleWhileRevalidate } from "@/lib/staleCache";
import { validateProgramAgeBounds, isLeaderAgeEligible } from "@/lib/programAge";


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
} as const;

// GET is the PUBLIC program catalog — anonymous callers legitimately get the
// non-draft list minus the members-only-and-hidden programs (asserted by
// programsAPI.integration.test.ts), so it can't move to withAuth (which 401s
// anonymous). getOptionalSessionUser applies the shared denied-household gate: a
// denied member is locked out of the whole app, so it collapses to undefined
// (anonymous) — they see only the public list and never the hidden members-only
// programs isDuesSettled would otherwise reveal.
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
                // Dues settled, not "is a member": a paid household awaiting
                // background clearance sees members-only programs too.
                canSeeMembersOnly = await isDuesSettled(user.id);
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
                        participants: { where: { person: LIVE_PERSON } },
                        volunteers: { where: { person: LIVE_PERSON } },
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
                    select: { id: true, _count: { select: { participants: { where: { person: LIVE_PERSON } }, volunteers: { where: { person: LIVE_PERSON } }, events: true } } },
                }).catch(() => null),
                new Promise<null>((resolve) => { const t = setTimeout(() => resolve(null), 2_500); t.unref?.(); }),
            ]);
            const countById = new Map((counts ?? []).map((c) => [c.id, c._count]));
            return NextResponse.json(staticRows.map((prg) => ({ ...prg, _count: countById.get(prg.id) })));
        }
        return NextResponse.json(await fetchPrograms());
    } catch (error) {
        await logBackendError(error, "GET /api/programs");
        return apiError("Failed to fetch programs", 500);
    }
}

export const POST = withAuth({ roles: ['isSysadmin', 'isBoardMember'] }, async (req, auth) => {
    if (auth.type !== 'session') return apiError("Unauthorized", 401);

    // Hoisted so the catch can name an orphaned Shopify product (created, but DB write failed) for manual cleanup.
    let shopifyData: { shopifyProductId: string, shopifyVariantId: string } | null = null;

    try {
        const body = await req.json();
        const { name, leadMentorId, startAt, endAt, orgMemberOnly, publiclyVisible, minAge, maxAge, memberPrice, nonMemberPrice, maxParticipants } = body;

        if (!name) {
            return apiError("Program name is required", 400);
        }

        if (!leadMentorId) {
            return apiError("Lead Mentor is required", 400);
        }

        const mentor = await prisma.person.findUnique({
            where: { id: parseInt(leadMentorId, 10) },
            select: { dateOfBirth: true, isDeclaredAdult: true },
        });
        if (!mentor) {
            return apiError("Lead mentor not found", 400);
        }
        if (!isLeaderAgeEligible(mentor)) {
            return apiError("Lead mentor must be at least 23 years old", 400);
        }

        if (!startAt) {
            return apiError("Start date is required", 400);
        }
        if (!endAt) {
            return apiError("End date is required", 400);
        }

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
        // variant. ponytail: falls back to the member
        // price only when no non-member price is set (e.g. a members-only-priced
        // program with no listed non-member tier) — normally sells at the
        // non-member/base rate per the design.
        const basePriceCents = nmPrice ?? mPrice ?? null;
        if (basePriceCents && basePriceCents > 0) {
            shopifyData = await createShopifySingleVariantProgram(name, basePriceCents, maxPart);
        }

        const newProgram = await prisma.program.create({
            data: {
                name,
                leadMentorId: parseInt(leadMentorId, 10),
                startAt: new Date(startAt),
                endAt: new Date(endAt),
                orgMemberOnly: orgMemberOnly || false,
                // publiclyVisible only has meaning for a members-only program; a
                // public one is already visible. Clamp so the nonsense state
                // (not members-only, yet flagged publiclyVisible) can't be stored.
                publiclyVisible: (orgMemberOnly || false) && (publiclyVisible || false),
                minAge: minAge || null,
                maxAge: maxAge || null,
                orgMemberPriceCents: mPrice,
                nonOrgMemberPriceCents: nmPrice,
                maxParticipants: maxPart,
                shopifyProductId: shopifyData?.shopifyProductId || null,
                shopifyVariantId: shopifyData?.shopifyVariantId || null,
            }
        });

        await prisma.auditLog.create({
            data: {
                actorId: auth.user.id,
                action: 'CREATE',
                tableName: 'Program',
                affectedEntityId: newProgram.id,
                newData: newProgram
            }
        });

        if (newProgram.leadMentorId) {
            await sendNotification(newProgram.leadMentorId, 'PROGRAM_ASSIGNMENT', { programName: newProgram.name, programId: newProgram.id });
        }

        const responseObj: Record<string, unknown> = { success: true, program: newProgram };
        if (((mPrice && mPrice > 0) || (nmPrice && nmPrice > 0)) && !shopifyData) {
            responseObj.warning = "Program created, but Shopify integration failed or is not configured. Payment links will not work.";
        }

        return NextResponse.json(responseObj);
    } catch (error: unknown) {
        if (shopifyData?.shopifyProductId) {
            logger.error("[Shopify] Orphaned product after program DB write failed, manual cleanup needed:", shopifyData.shopifyProductId);
        }
        await logBackendError(error, "POST /api/programs");
        return apiError("Failed to create program", 500);
    }
});
