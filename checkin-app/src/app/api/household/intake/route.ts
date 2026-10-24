import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { getIntakeState, saveIntake } from "@/lib/membership/intake";
import { intakeErrorResponse } from "@/lib/membership/intakeResponse";
import { apiError } from "@/lib/api-response";

export const dynamic = "force-dynamic";

/**
 * Program-context household intake. Lets an auth-first program registrant fill
 * the household details (address, emergency contact, primary parent, children)
 * that the enroll step needs, when they arrive with a fresh single-person
 * household. The sign-in-before-intake rule is in docs/rules/programs.md
 * (Enrollment).
 *
 * Deliberately PROCESS-FREE: it calls the membership intake service's
 * getIntakeState / saveIntake WITHOUT opening or advancing an
 * OrgMembershipProcess (that's startIntake / submitIntake — membership only).
 * Enrolling in one workshop is not a membership application. saveIntake itself
 * scopes every write to the caller's own household and requires household
 * leadership, so no extra authorization is needed here beyond a session.
 */

// GET /api/household/intake — prefill the intake form for the caller's household.
export const GET = withAuth({}, async (_req, auth) => {
    if (auth.type !== "session") return apiError("Unauthorized", 401);
    try {
        return NextResponse.json(await getIntakeState(auth.user.id));
    } catch (error) {
        return intakeErrorResponse(error, "Household intake GET error");
    }
});

// POST /api/household/intake — save (partial) intake data. Resumable; never deletes.
export const POST = withAuth({}, async (req, auth) => {
    if (auth.type !== "session") return apiError("Unauthorized", 401);
    try {
        const body = await req.json();
        const { state, rejections } = await saveIntake(auth.user.id, body);
        return NextResponse.json({ state, rejections });
    } catch (error) {
        return intakeErrorResponse(error, "Household intake save error");
    }
});
