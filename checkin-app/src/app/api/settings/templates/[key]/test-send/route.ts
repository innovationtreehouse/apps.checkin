import { ApiResponseError, badRequest, handler, unauthorized } from "@/security/handler";
import { sendTemplateTest } from "@/lib/email-templates/send";
import { readDraft } from "../draft";

export const dynamic = "force-dynamic";

/**
 * POST /api/settings/templates/[key]/test-send — send the editor's unsaved
 * subject/body, filled from the key's sample values, to the caller's own address.
 */
export const POST = handler<{ key: string }>("POST /api/settings/templates/[key]/test-send", async ({ req, auth, params }) => {
    if (auth.type !== "session") throw unauthorized();
    const to = auth.user.email;
    if (!to) throw badRequest("Your account has no email on file.");
    const { key, subject, body } = await readDraft(req, params.key);
    if (!(await sendTemplateTest(key, to, { subject, body }))) throw new ApiResponseError(502, "The test email could not be sent.");
    return {};
});
