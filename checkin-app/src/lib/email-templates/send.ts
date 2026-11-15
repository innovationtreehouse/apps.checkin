import { sendEmail } from "@/lib/email";
import prisma from "@/lib/prisma";
import { REGISTRY, type TemplateCtx, type TemplateKey, type TemplateSpec } from "./registry";
import { renderTemplate, withDefaults } from "./tokens";

/**
 * The Board's saved copy for `key`, or null when there is none. A DB error also
 * yields null, so a template-table hiccup sends the default instead of no mail.
 */
async function findOverride(key: TemplateKey) {
    try {
        return await prisma.emailTemplate.findUnique({ where: { key }, select: { subject: true, body: true } });
    } catch (err) {
        console.error(`[Email Template] Failed to read ${key}, sending the default:`, err);
        return null;
    }
}

/**
 * Send the email `key` to `to`: the Board's row if it has one, else the registry
 * default, field by field, so neither subject nor body is ever blank. Resolves
 * to the `sendEmail` result and never rejects. Callers still check the
 * recipient's notification preferences before calling. `appendix` is plain text
 * added after the body, outside token substitution and the Board's edits.
 */
export async function sendTemplated<K extends TemplateKey>(key: K, to: string, ctx: TemplateCtx<K>, headers?: Record<string, string>, appendix?: string): Promise<boolean>;
export async function sendTemplated(key: TemplateKey, to: string, ctx: Record<string, string>, headers?: Record<string, string>, appendix?: string): Promise<boolean> {
    const spec: TemplateSpec = REGISTRY[key];
    const copy = withDefaults(spec, await findOverride(key));
    const { subject, html } = renderTemplate(copy.subject, copy.body, ctx, spec.allowedTokens, appendix);
    return headers ? sendEmail(to, subject, html, headers) : sendEmail(to, subject, html);
}

/**
 * Send unsaved copy for `key` to `to`, filled from the key's sample values and
 * marked `[Test]`. A blank field sends its registry default, as a saved row would.
 */
export async function sendTemplateTest(key: TemplateKey, to: string, draft: { subject: string; body: string }): Promise<boolean> {
    const spec: TemplateSpec = REGISTRY[key];
    const copy = withDefaults(spec, draft);
    const { subject, html } = renderTemplate(copy.subject, copy.body, spec.sampleCtx, spec.allowedTokens);
    return sendEmail(to, `[Test] ${subject}`, html);
}
