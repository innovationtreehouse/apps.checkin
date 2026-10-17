import { escapeHtml } from "@/lib/email-templates/base";

/**
 * Default ACK copy + rendering, split out from scholarshipEmails.ts so a
 * "use client" page (settings/email/page.tsx) can import the real constants
 * without bundling that module's prisma dependency. Depends only on
 * escapeHtml, which itself has no imports and is client-safe.
 */

export const DEFAULT_ACK_SUBJECT = "We received your scholarship / payment-plan request";
export const DEFAULT_ACK_MEMBERSHIP_BODY =
    "Hi — we've received your household's scholarship / payment-plan request for your Treehouse membership fee. "
    + "The Scholarship Review Team will review it and follow up.";
export const DEFAULT_ACK_PROGRAM_BODY =
    "Hi — we've received your scholarship / payment-plan request for {{programName}}. "
    + "The Scholarship Review Team will review it and follow up. Your spot is held while they do.";

/**
 * Render a plain-text ACK template into email-safe HTML: escape first (so a
 * `{{programName}}` value — or the template itself — can never inject markup),
 * substitute `{{programName}}` with its escaped value, then split on line
 * breaks into `<p>` paragraphs (blank lines dropped). Deliberately NOT an
 * HTML-authoring surface — no dangerouslySetInnerHTML, no preview iframe (see
 * the outreach template's sandboxed-iframe preview, settings/outreach/page.tsx,
 * for the XSS history this avoids by construction).
 */
export function renderAckBody(template: string, vars: { programName?: string } = {}): string {
    const escaped = escapeHtml(template).replaceAll("{{programName}}", escapeHtml(vars.programName ?? ""));
    return escaped
        .split(/\r\n|\r|\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => `<p>${line}</p>`)
        .join("");
}
