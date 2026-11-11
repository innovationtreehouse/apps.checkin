import { config } from "@/lib/config";
import { constantTimeEqual } from "@/lib/signatureCompare";

/**
 * Zoho Sign contract webhook helpers.
 *
 * Zoho Sign has no strong native HMAC; instead we configure the webhook in Zoho
 * with a custom header carrying a shared secret (ZOHO_WEBHOOK_SECRET) and verify
 * it here with a timing-safe compare. The header name is configurable so it can
 * match whatever the Zoho webhook config uses.
 *
 * NOTE: confirm the exact Zoho Sign webhook payload shape + header against the
 * live Zoho config when credentials are available; the parser below is tolerant
 * of the documented variants (request_id / request_status).
 */
export const ZOHO_WEBHOOK_HEADER = "x-zoho-webhook-token";

/** Timing-safe shared-secret check. Returns false if the secret is unset. */
export function verifyZohoToken(headerToken: string | null | undefined): boolean {
    const secret = config.zohoWebhookSecret();
    if (!secret || !headerToken) return false;
    return constantTimeEqual(headerToken, secret);
}

export interface ZohoWebhookResult {
    requestId: string | null;
    /** True when the signing request reached a fully-signed/completed state. */
    completed: boolean;
}

/**
 * Pull the request id + completion out of a Zoho Sign webhook body, tolerant of
 * the documented shapes:
 *   { requests: { request_id, request_status } }
 *   { request_id, request_status }
 *   { notifications: { ... } } wrappers
 * "completed" maps from request_status === "completed".
 */
export function parseZohoWebhook(body: unknown): ZohoWebhookResult {
    const root = (body ?? {}) as Record<string, unknown>;
    const candidates: Record<string, unknown>[] = [root];
    for (const key of ["requests", "request", "notifications", "data"]) {
        const nested = root[key];
        if (nested && typeof nested === "object") candidates.push(nested as Record<string, unknown>);
    }

    let requestId: string | null = null;
    let status: string | null = null;
    for (const c of candidates) {
        const id = c["request_id"] ?? c["requestId"] ?? c["request_id_str"];
        if (id != null && requestId == null) requestId = String(id);
        const s = c["request_status"] ?? c["requestStatus"] ?? c["status"];
        if (typeof s === "string" && status == null) status = s;
    }

    return { requestId, completed: status?.toLowerCase() === "completed" };
}
