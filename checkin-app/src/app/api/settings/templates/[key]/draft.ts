import type { NextRequest } from "next/server";
import { badRequest, notFound } from "@/security/handler";
import { REGISTRY, type TemplateKey } from "@/lib/email-templates/registry";
import { findUnknownTokens } from "@/lib/email-templates/tokens";

const MAX_LEN = 5000;

/** The registry key in the path and the subject/body in the request, token-validated. */
export async function readDraft(req: NextRequest, key: string): Promise<{ key: TemplateKey; subject: string; body: string }> {
    if (!Object.hasOwn(REGISTRY, key)) throw notFound("No such email template");
    const spec = REGISTRY[key as TemplateKey];
    let input: unknown;
    try {
        input = await req.json();
    } catch {
        throw badRequest("Invalid JSON");
    }
    if (typeof input !== "object" || input === null) throw badRequest("Send a subject and a body");
    const { subject, body } = input as { subject?: unknown; body?: unknown };
    const draft = { subject, body };
    for (const field of ["subject", "body"] as const) {
        const value = draft[field];
        if (typeof value !== "string") throw badRequest(`${field} must be a string`);
        if (value.length > MAX_LEN) throw badRequest(`The ${field} must be ${MAX_LEN} characters or fewer`);
        const unknown = findUnknownTokens(value, spec.allowedTokens);
        if (unknown.length) throw badRequest(`The ${field} uses {{${unknown[0]}}}, which this email does not have`);
    }
    return { key: key as TemplateKey, subject: draft.subject as string, body: draft.body as string };
}
