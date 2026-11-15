import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { apiError } from "@/lib/api-response";
import { sendEmail } from "@/lib/email";
import { renderOutreachEmail, resolveBoundary, BoundaryNotSetError } from "@/lib/outreach/render";
import { findUnknownTokens } from "@/lib/outreach/tokens";
import type { BusinessRole } from "@/types/auth";

export const dynamic = "force-dynamic";

const ROLES: BusinessRole[] = ["isBoardMember", "isSysadmin", "isOperations"];
const SAMPLE_NAME = "Jordan Rivera";

/**
 * POST /api/outreach/test-send — renders whatever template is currently in the editor
 * (the body carries the live text, not a saved-column read) and sends it to the caller's
 * own address, with sample name "Jordan Rivera" and the real next boundary.
 */
export const POST = withAuth({ roles: ROLES }, async (req, auth) => {
    if (auth.type !== "session") return apiError("Unauthorized", 401);
    const to = auth.user.email;
    if (!to) return apiError("Your account has no email on file.", 400);

    let body: { subject?: string; body?: string };
    try {
        body = await req.json();
    } catch {
        return apiError("Invalid JSON", 400);
    }
    const subjectTemplate = body.subject ?? "";
    const bodyTemplate = body.body ?? "";
    const unknown = [...findUnknownTokens(subjectTemplate), ...findUnknownTokens(bodyTemplate)];
    if (unknown.length) return apiError(`Unknown token {{${unknown[0]}}}`, 400);

    let boundary;
    try {
        boundary = await resolveBoundary(new Date());
    } catch (e) {
        if (e instanceof BoundaryNotSetError) return apiError(e.message, 400);
        throw e;
    }

    const { subject, html } = renderOutreachEmail(subjectTemplate, bodyTemplate, { name: SAMPLE_NAME, boundary });
    await sendEmail(to, `[Test] ${subject}`, html);

    return NextResponse.json({ success: true });
});
