import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { IntakeError } from "@/lib/membership/intake";
import { EmergencyContactError } from "@/lib/emergencyContacts/service";

const STATUS_FOR: Record<IntakeError["code"], number> = {
    no_household: 400,
    not_lead: 403,
    already_member: 409,
    no_process: 400,
    incomplete: 400,
    lead_limit: 400,
    name_required: 400,
    email_designated: 400,
};

/**
 * Map an intake-service error to its HTTP response, shared by the membership
 * routes. A known IntakeError becomes a 4xx carrying its `code` and any `fields`
 * (so the form can highlight the offending inputs — on every environment).
 *
 * The emergency-contact write model (saveIntake -> upsertPrimaryContact) throws
 * its own EmergencyContactError; surface it as a 400 against the
 * `emergencyContact` field so the form highlights it like any other validation
 * failure, rather than letting it fall through to a generic 500.
 *
 * Anything else is an unexpected 500: the full error is logged, and its message
 * is echoed back as `detail` ONLY on dev/local instances so an internal tester
 * isn't stuck on a blank "Internal Server Error". Prod stays generic — we never
 * leak DB/stack detail to applicants.
 */
export function intakeErrorResponse(error: unknown, logContext: string) {
    if (error instanceof IntakeError) {
        return NextResponse.json(
            { error: error.message, code: error.code, ...(error.fields ? { fields: error.fields } : {}) },
            { status: STATUS_FOR[error.code] },
        );
    }
    if (error instanceof EmergencyContactError) {
        return NextResponse.json(
            { error: error.message, code: error.code, fields: ["emergencyContact"] },
            { status: 400 },
        );
    }
    console.error(`${logContext}:`, error);
    const detail = config.isDevInstance() ? (error instanceof Error ? error.message : String(error)) : undefined;
    return NextResponse.json({ error: "Internal Server Error", ...(detail ? { detail } : {}) }, { status: 500 });
}
