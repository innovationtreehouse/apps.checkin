import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { apiError } from "@/lib/api-response";
import { LIVE_PERSON, isSignInVerified } from "@/lib/person/filters";
import { canonicalizeEmail } from "@/lib/emailNormalize";
import { handler } from "@/security/handler";
import { refuseSelfGrant, SELF_GRANT_REFUSAL_MESSAGE } from "@/lib/membership/selfGrantGuard";

export const dynamic = "force-dynamic";

const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** GET — list all volunteer email designations.
 *  Registry-governed: admission anyRole sysadmin/board; envelope 'designations'.
 *  Designation email is pii — covered by the admin band, stripped for any
 *  future role a view adds. */
export const GET = handler('GET /api/settings/membership/volunteer-designations', async () => {
    const designations = await prisma.volunteerDesignation.findMany({ orderBy: { createdAt: "desc" } });
    return { VolunteerDesignation: designations };
});

/**
 * POST — designate a volunteer household. Body: { email, confirmHouseholdId? }.
 *
 * Only a person whose address is sign-in-verified counts as its holder. When one
 * such person's household has a membership, the address is never stored: only a
 * confirm naming that household sets its OrgMembership.isVolunteer (audited).
 * Otherwise the address is stored as a designation, the dues preload. Every
 * response lists every person on file with the address, verified or not, so the
 * Board sees who else holds it.
 */
export const POST = withAuth({ roles: ["isSysadmin", "isBoardMember"] }, async (req, auth) => {
    if (auth.type !== "session") return apiError("Unauthorized", 401);
    let body: { email?: string; confirmHouseholdId?: number };
    try {
        body = await req.json();
    } catch {
        return apiError("Invalid JSON", 400);
    }
    // Store the canonical inbox key, the same key matchesVolunteerDesignation
    // matches on — otherwise the @unique column guards a key nobody reads and
    // variants of one inbox (plus-tag, Gmail dots) become separate designations.
    const email = body.email ? canonicalizeEmail(body.email) : undefined;
    if (!email || !emailRegex.test(email)) {
        return apiError("A valid email is required", 400);
    }

    // A designation discounts the household's dues, so no actor may designate
    // themselves or anyone in their own household.
    if (await refuseSelfGrant(prisma, auth.user.id, { email }, { table: "VolunteerDesignation", attempted: { email } })) {
        return apiError(SELF_GRANT_REFUSAL_MESSAGE, 403);
    }

    // ponytail: O(n) scan over people with an email, no indexed canonical column
    // — same tradeoff as volunteer-memberships, fine at this org's scale.
    const people = await prisma.person.findMany({
        where: { email: { not: null }, ...LIVE_PERSON },
        select: {
            name: true,
            email: true,
            _count: { select: { accounts: true } },
            household: { select: { id: true, name: true, orgMembership: { select: { id: true, isVolunteer: true } } } },
        },
    });
    const holders = people.filter((p) => canonicalizeEmail(p.email!) === email);
    const matches = holders.map((p) => ({
        personName: p.name,
        householdId: p.household.id,
        householdName: p.household.name,
        hasMembership: p.household.orgMembership !== null,
        isVolunteer: p.household.orgMembership?.isVolunteer ?? false,
        signInVerified: isSignInVerified(p),
    }));
    const confirmable = holders.filter((p) => p.household.orgMembership && isSignInVerified(p));

    if (confirmable.length > 0) {
        if (new Set(confirmable.map((p) => p.household.id)).size > 1) {
            return NextResponse.json(
                { error: "This email matches people in more than one household. Set the volunteer checkbox on the household instead.", matches },
                { status: 409 },
            );
        }
        const { name: personName, household } = confirmable[0];
        const { id: householdId, name: householdName, orgMembership } = household;
        const membership = orgMembership!;
        if (body.confirmHouseholdId === undefined) {
            return NextResponse.json({
                requiresConfirmation: true,
                match: { personName, householdId, householdName, isVolunteer: membership.isVolunteer },
                matches,
            });
        }
        if (body.confirmHouseholdId !== householdId) {
            return apiError("This email no longer matches that household. Look it up again.", 409);
        }
        await prisma.$transaction(async (tx) => {
            await tx.orgMembership.update({ where: { id: membership.id }, data: { isVolunteer: true } });
            await tx.auditLog.create({
                data: {
                    actorId: auth.user.id,
                    action: "EDIT",
                    tableName: "OrgMembership",
                    affectedEntityId: membership.id,
                    secondaryAffectedEntity: householdId,
                    oldData: { isVolunteer: membership.isVolunteer },
                    newData: { isVolunteer: true },
                },
            });
        });
        return NextResponse.json({ household: { id: householdId, name: householdName }, isVolunteer: true, matches });
    }

    // Canonicalize both sides: rows stored before canonicalization still dedupe.
    const all = await prisma.volunteerDesignation.findMany();
    const existing = all.find((d) => canonicalizeEmail(d.email) === email);
    if (existing) return NextResponse.json({ designation: existing, warning: "This email is already designated.", matches });

    const designation = await prisma.$transaction(async (tx) => {
        const created = await tx.volunteerDesignation.create({ data: { email, createdById: auth.user.id } });
        await tx.auditLog.create({
            data: {
                actorId: auth.user.id,
                action: "CREATE",
                tableName: "VolunteerDesignation",
                affectedEntityId: created.id,
                newData: { email },
            },
        });
        return created;
    });
    return NextResponse.json({ designation, matches }, { status: 201 });
});

/** DELETE — remove a designation. Query: ?id=<n>. */
export const DELETE = withAuth({ roles: ["isSysadmin", "isBoardMember"] }, async (req) => {
    const id = parseInt(new URL(req.url).searchParams.get("id") || "", 10);
    if (isNaN(id)) return apiError("id is required", 400);
    await prisma.volunteerDesignation.delete({ where: { id } }).catch(() => null);
    return NextResponse.json({ success: true });
});
