import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { apiError } from "@/lib/api-response";
import { LIVE_PERSON } from "@/lib/person/filters";
import { canonicalizeEmail } from "@/lib/emailNormalize";
import { handler } from "@/security/handler";

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
 * POST — designate an email as a volunteer household. Body: { email }.
 * Non-blocking warning if that email already has an ACTIVE, full-price membership.
 */
export const POST = withAuth({ roles: ["isSysadmin", "isBoardMember"] }, async (req, auth) => {
    if (auth.type !== "session") return apiError("Unauthorized", 401);
    let body: { email?: string };
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
    if (await isOwnHouseholdEmail(auth.user.id, email)) {
        return apiError("You cannot designate yourself or your own household — someone outside your household must.", 403);
    }

    // Canonicalize both sides: rows stored before canonicalization still dedupe.
    const all = await prisma.volunteerDesignation.findMany();
    const existing = all.find((d) => canonicalizeEmail(d.email) === email);
    if (existing) return NextResponse.json({ designation: existing, warning: "This email is already designated." });

    // Non-blocking warning: is this email already an active full-price member?
    let warning: string | undefined;
    const participant = await prisma.person.findFirst({
        where: { email: { equals: email, mode: "insensitive" }, ...LIVE_PERSON },
        select: { household: { select: { orgMembership: { select: { status: true, isVolunteer: true } } } } },
    });
    const m = participant?.household?.orgMembership;
    if (m?.status === "ACTIVE" && !m.isVolunteer) {
        warning = "Heads up: this email already has an active full-price membership. The system can't change that — this designation only applies to their next membership cycle.";
    }

    const designation = await prisma.volunteerDesignation.create({ data: { email, createdById: auth.user.id } });
    return NextResponse.json({ designation, warning }, { status: 201 });
});

/** Whether `email` (canonical) belongs to the actor or a member of the actor's household. */
async function isOwnHouseholdEmail(actorId: number, email: string): Promise<boolean> {
    const actor = await prisma.person.findUnique({ where: { id: actorId }, select: { email: true, householdId: true } });
    if (!actor) return false;
    const members = actor.householdId == null ? [] : await prisma.person.findMany({
        where: { householdId: actor.householdId },
        select: { email: true },
    });
    return [actor, ...members].some((p) => p.email != null && canonicalizeEmail(p.email) === email);
}

/** DELETE — remove a designation. Query: ?id=<n>. */
export const DELETE = withAuth({ roles: ["isSysadmin", "isBoardMember"] }, async (req) => {
    const id = parseInt(new URL(req.url).searchParams.get("id") || "", 10);
    if (isNaN(id)) return apiError("id is required", 400);
    await prisma.volunteerDesignation.delete({ where: { id } }).catch(() => null);
    return NextResponse.json({ success: true });
});
