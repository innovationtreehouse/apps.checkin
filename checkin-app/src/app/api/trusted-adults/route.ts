import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { withAuth } from "@/lib/auth";
import { createTrustedAdult, TrustedAdultError } from "@/lib/trusted-adult/service";
import { apiError } from "@/lib/api-response";

export const dynamic = "force-dynamic";

const STATUS_FOR: Record<TrustedAdultError["code"], number> = {
    not_found: 404,
    bad_input: 400,
    wrong_phase: 409,
    forbidden: 403,
    already_open: 409,
};

interface Body {
    householdId?: number;
    trustedAdultPersonId?: number | null;
    trustedAdultName?: string;
    trustedAdultPhone?: string;
    trustedAdultEmail?: string;
    familyContext?: string;
}

/**
 * POST /api/trusted-adults — disclose a trusted adult for a household.
 *
 * A signed-in member discloses for their OWN household by default. Board/isSysadmin
 * may enter on another household's behalf by passing householdId (STAFF_ENTERED).
 */
export const POST = withAuth({}, async (req, auth) => {
    if (auth.type !== "session") return apiError("Unauthorized", 401);
    let body: Body;
    try {
        body = await req.json();
    } catch {
        return apiError("Invalid JSON", 400);
    }
    if (!body.trustedAdultName || !body.familyContext) {
        return apiError("trustedAdultName and familyContext are required", 400);
    }

    let householdId: number | undefined;
    const disclosedById = auth.user.id;
    let origin: "SELF_DISCLOSED" | "STAFF_ENTERED" = "SELF_DISCLOSED";

    const isStaff = auth.user.isBoardMember || auth.user.isSysadmin;
    if (body.householdId && body.householdId !== auth.user.householdId) {
        if (!isStaff) {
            return apiError("You may only add trusted adults for your own household.", 403);
        }
        householdId = body.householdId;
        origin = "STAFF_ENTERED";
    } else {
        householdId = auth.user.householdId;
    }

    try {
        const ta = await createTrustedAdult({
            householdId: householdId!,
            trustedAdultPersonId: body.trustedAdultPersonId ?? null,
            trustedAdultName: body.trustedAdultName,
            trustedAdultPhone: body.trustedAdultPhone,
            trustedAdultEmail: body.trustedAdultEmail,
            familyContext: body.familyContext,
            origin,
            disclosedById,
        });
        return NextResponse.json({ id: ta.id }, { status: 201 });
    } catch (error) {
        if (error instanceof TrustedAdultError) {
            return NextResponse.json({ error: error.message, code: error.code }, { status: STATUS_FOR[error.code] });
        }
        logger.error("Trusted adult create error:", error);
        return apiError("Internal Server Error", 500);
    }
});
