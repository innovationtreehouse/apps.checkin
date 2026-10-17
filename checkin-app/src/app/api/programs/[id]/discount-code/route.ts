import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { apiError } from "@/lib/api-response";
import { isDuesSettled, isDuesSettledThrough, programCoverageDate } from "@/lib/orgMembership";
import { mintMemberDiscountCode } from "@/lib/shopify";
import { checkoutVariantId } from "@/lib/programs/variants";
import { fromWhere } from "@/lib/programs/enrollmentState";
import { LIVE_PERSON } from "@/lib/person/filters";
import { householdLeadship } from "@/lib/household/leads";

// Server-minted, single-use member discount code for a single-pool program's
// checkout link (see mintMemberDiscountCode in lib/shopify.ts), bound to the
// caller's household. Recomputes membership from the session server-side — never
// trusts a client-supplied "I'm a member" flag for a pricing decision.
//
// Only a household lead pays for the household (a youth is enrolled by their
// lead — docs/rules/programs.md), so anyone else is refused with a 403.
// One order pays for one household: `participantIds` (the children in this
// checkout) must all be in the caller's household, or the checkout is refused
// with a 400. Otherwise always 200s, with { code: null } when a discount doesn't
// apply (not a member / legacy program / no unpaid claim / mint failure) — the
// caller falls back to an undiscounted checkout link.
export const POST = withAuth({}, async (req, auth, { params }: { params: Promise<{ id: string }> }) => {
    if (auth.type !== 'session') return apiError("Unauthorized", 401);
    const { id } = await params;
    const programId = parseInt(id, 10);
    if (isNaN(programId)) return apiError("Invalid program ID", 400);

    const body: unknown = await req.json().catch(() => null);
    const raw = body && typeof body === "object" && "participantIds" in body ? body.participantIds : null;
    const ids = Array.isArray(raw) ? raw.filter((n): n is number => Number.isInteger(n)) : [];
    if (!Array.isArray(raw) || ids.length === 0 || ids.length !== raw.length) {
        return apiError("participantIds is required", 400);
    }
    const participantIds = [...new Set(ids)];

    const program = await prisma.program.findUnique({ where: { id: programId } });
    if (!program) return apiError("Program not found", 404);

    const caller = await householdLeadship(auth.user.id);
    if (!caller?.canManage) return apiError("Only a household lead can pay for the household.", 403);
    const enrollees = await prisma.person.findMany({ where: { id: { in: participantIds }, ...LIVE_PERSON }, select: { householdId: true } });
    if (enrollees.length !== participantIds.length || enrollees.some((e) => e.householdId !== caller.householdId)) {
        return apiError("Everyone in one checkout must be from your household. Pay for each household separately.", 400);
    }

    // The discount is the gap between the two prices, so both must be known.
    const variantId = checkoutVariantId(program);
    if (!variantId || program.orgMemberPriceCents == null || program.nonOrgMemberPriceCents == null) {
        return NextResponse.json({ code: null });
    }

    // Dues settled, not "is a member": a household that has paid and is waiting on
    // background clearance pays the member rate too (#1397).
    const isMemberNow = await isDuesSettled(auth.user.id);
    if (!isMemberNow) return NextResponse.json({ code: null });

    // Settled dues don't necessarily cover the program's WHOLE run — a
    // not-yet-renewed household is valid only through the upcoming membership-year
    // boundary, so a program ending after that boundary must charge full price.
    const covers = await isDuesSettledThrough(auth.user.id, programCoverageDate(program));
    if (!covers) return NextResponse.json({ code: null, reason: "membership_ends_before_program" });

    const amountOffCents = program.nonOrgMemberPriceCents - program.orgMemberPriceCents;
    if (amountOffCents <= 0) return NextResponse.json({ code: null });

    // A code is minted only for a checkout that pays for real unpaid claims.
    const unpaid = await prisma.programParticipant.count({
        where: { programId, personId: { in: participantIds }, person: LIVE_PERSON, ...fromWhere("PENDING_UNPAID") },
    });
    if (unpaid !== participantIds.length) return NextResponse.json({ code: null });

    const code = await mintMemberDiscountCode(programId, caller.householdId, variantId, amountOffCents);
    return NextResponse.json({ code });
});
