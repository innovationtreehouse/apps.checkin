import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import prisma from "@/lib/prisma";
import { withAuth } from "@/lib/auth";
import { markContractSigned, markBgConsent, setZohoEnvelope, resetSigning, ExternalError } from "@/lib/membership/external";
import { applicantHousehold } from "@/lib/membership/review";
import { hasHouseholdConflict } from "@/lib/conflictOfInterest";
import { apiError } from "@/lib/api-response";

export const dynamic = "force-dynamic";

/**
 * POST /api/membership-ops/applications/external — board controls for the EXTERNAL phase.
 *
 * Body: { processId, action, envelopeId?, reason? }
 *   action 'mark-contract'    — manually record the contract as signed (fallback to the Zoho webhook)
 *   action 'mark-bg-consent'  — human-mark that Averity consent was submitted
 *   action 'set-envelope'     — associate a Zoho signing request id (needs envelopeId)
 *   action 'reset-signing'    — recall the open Zoho request so another lead can sign (needs reason)
 *
 * Completing the contract + background-check consent advances the application to
 * PENDING_PAYMENT; the background check then reviews in parallel with payment.
 */
export const POST = withAuth({ roles: ["isSysadmin", "isBoardMember"] }, async (req, auth) => {
    if (auth.type !== "session") return apiError("Unauthorized", 401);
    const actorId = auth.user.id;

    let body: { processId?: number; action?: string; envelopeId?: string; reason?: string };
    try {
        body = await req.json();
    } catch {
        return apiError("Invalid JSON", 400);
    }

    const { processId, action, envelopeId, reason } = body;
    if (!processId || !action) {
        return apiError("processId and action are required", 400);
    }

    // Conflict of interest, guarding EVERY action here — mirrors certifyPaymentPlan
    // and overrideBlocked. Marking your own household's contract signed or its BG
    // consent received advances the application to PENDING_PAYMENT with no Zoho
    // envelope and no consent behind it. No role bypasses this.
    //
    // The guard belongs on the route, not in the service: markContractSigned is also
    // the Zoho webhook's entry point (system actor), and markBgConsent is what
    // selfRecordBgConsent calls, where the actor IS the applicant by design.
    const process = await prisma.orgMembershipProcess.findUnique({
        where: { id: processId },
        select: { orgMembershipId: true, subjectPersonId: true },
    });
    if (!process) return apiError("Application not found", 404);
    if (await hasHouseholdConflict(prisma, actorId, await applicantHousehold(prisma, process))) {
        return apiError("You cannot act on your own household's application — someone outside your household must.", 403);
    }

    try {
        switch (action) {
            case "mark-contract":
                return NextResponse.json({ process: await markContractSigned(processId, actorId) });
            case "mark-bg-consent":
                return NextResponse.json({ process: await markBgConsent(processId, actorId) });
            case "set-envelope":
                if (!envelopeId) return apiError("envelopeId is required", 400);
                return NextResponse.json({ process: await setZohoEnvelope(processId, envelopeId, actorId) });
            case "reset-signing":
                if (!reason?.trim()) return apiError("reason is required", 400);
                return NextResponse.json({ process: await resetSigning(processId, actorId, reason.trim()) });
            default:
                return apiError(`Unknown action: ${action}`, 400);
        }
    } catch (error) {
        if (error instanceof ExternalError) {
            return NextResponse.json({ error: error.message, code: error.code }, { status: error.code === "not_found" ? 404 : 400 });
        }
        logger.error("Membership external action error:", error);
        return apiError("Internal Server Error", 500);
    }
});
