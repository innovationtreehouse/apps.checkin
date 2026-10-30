import { sendEmail } from "@/lib/email";
import prisma from "@/lib/prisma";
import { baseEmailLayout } from "./base";
import { REGISTRY, type TemplateCtx, type TemplateKey, type TemplateSpec } from "./registry";
import { renderBodyHtml, substituteTokens } from "./tokens";

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
 * recipient's notification preferences before calling.
 */
export async function sendTemplated<K extends TemplateKey>(key: K, to: string, ctx: TemplateCtx<K>, headers?: Record<string, string>): Promise<boolean>;
export async function sendTemplated(key: TemplateKey, to: string, ctx: Record<string, string>, headers?: Record<string, string>): Promise<boolean> {
    const spec: TemplateSpec = REGISTRY[key];
    const row = await findOverride(key);
    const subject = row?.subject.trim() ? row.subject : spec.defaultSubject;
    const body = row?.body.trim() ? row.body : spec.defaultBody;
    const renderedSubject = substituteTokens(subject, ctx, spec.allowedTokens, { escape: false });
    const html = baseEmailLayout(renderBodyHtml(substituteTokens(body, ctx, spec.allowedTokens, { escape: true })));
    return headers ? sendEmail(to, renderedSubject, html, headers) : sendEmail(to, renderedSubject, html);
}
