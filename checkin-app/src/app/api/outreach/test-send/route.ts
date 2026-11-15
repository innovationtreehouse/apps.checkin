import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import { apiError } from "@/lib/api-response";
import { sendTemplateTest } from "@/lib/email-templates/send";
import { REGISTRY } from "@/lib/email-templates/registry";
import { findUnknownTokens } from "@/lib/email-templates/tokens";
import { outreachCtx, OUTREACH_KEY, resolveBoundary, BoundaryNotSetError, type EmailType } from "@/lib/outreach/render";
import type { BusinessRole } from "@/types/auth";

export const dynamic = "force-dynamic";

const ROLES: BusinessRole[] = ["isBoardMember", "isSysadmin", "isOperations"];
const SAMPLE_NAME = "Jordan Rivera";

/**
 * POST /api/outreach/test-send — renders whatever template is currently in the editor
 * (the body carries the live text, not a saved read) and sends it to the caller's own
 * address, with sample name "Jordan Rivera" and the real next boundary. A blank field
 * sends that campaign's default; `emailType` defaults to "opening".
 */
export const POST = withAuth({ roles: ROLES }, async (req, auth) => {
    if (auth.type !== "session") return apiError("Unauthorized", 401);
    const to = auth.user.email;
    if (!to) return apiError("Your account has no email on file.", 400);

    let body: { emailType?: string; subject?: string; body?: string };
    try {
        body = await req.json();
    } catch {
        return apiError("Invalid JSON", 400);
    }
    const emailType: EmailType = body.emailType === "reminder" ? "reminder" : "opening";
    const key = OUTREACH_KEY[emailType];
    const draft = { subject: body.subject ?? "", body: body.body ?? "" };
    const tokens = REGISTRY[key].allowedTokens;
    const unknown = [...findUnknownTokens(draft.subject, tokens), ...findUnknownTokens(draft.body, tokens)];
    if (unknown.length) return apiError(`Unknown token {{${unknown[0]}}}`, 400);

    let boundary;
    try {
        boundary = await resolveBoundary(new Date());
    } catch (e) {
        if (e instanceof BoundaryNotSetError) return apiError(e.message, 400);
        throw e;
    }

    await sendTemplateTest(key, to, draft, outreachCtx(SAMPLE_NAME, boundary));

    return NextResponse.json({ success: true });
});
