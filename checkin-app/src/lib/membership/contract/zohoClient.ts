import { config } from "@/lib/config";
import { toZohoFields, type FieldPrefill } from "@/lib/membership/contract/signFields";

/**
 * Zoho Sign API client — the "send for signature" half of the integration, a
 * TypeScript port of innovationtreehouse/sign-script (send_for_signature.py).
 *
 * Flow: getAccessToken (OAuth refresh) → createRequest (upload PDF + register the
 * single SIGN recipient) → submitRequest (attach the agreement's signature fields)
 * → getEmbeddedSignUrl (mint a short-lived in-app signing session). The webhook
 * half lives in contract/zoho.ts + external.ts and is unchanged.
 *
 * Server-only: reads OAuth secrets via config and is never imported client-side.
 */

export class ZohoError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ZohoError";
    }
}

/**
 * Hard per-request deadline for every Zoho call. Without it a hung TCP connection
 * (established, no response) blocks the request worker until the platform timeout —
 * during a Zoho outage that exhausts workers. ~20s suits these interactive flows.
 */
const ZOHO_FETCH_TIMEOUT_MS = 20_000;

/** fetch with a hard timeout that surfaces as a clear ZohoError instead of hanging. */
async function zohoFetch(input: string | URL, init: RequestInit, label: string): Promise<Response> {
    try {
        return await fetch(input, { ...init, signal: AbortSignal.timeout(ZOHO_FETCH_TIMEOUT_MS) });
    } catch (err) {
        if (err instanceof DOMException && (err.name === "TimeoutError" || err.name === "AbortError")) {
            throw new ZohoError(`${label} timed out after ${ZOHO_FETCH_TIMEOUT_MS}ms`);
        }
        throw err;
    }
}

function requireSecrets(): { clientId: string; clientSecret: string; refreshToken: string } {
    const clientId = config.zohoClientId();
    const clientSecret = config.zohoClientSecret();
    const refreshToken = config.zohoRefreshToken();
    if (!clientId || !clientSecret || !refreshToken) {
        throw new ZohoError("Zoho Sign is not configured (missing ZOHO_CLIENT_ID/SECRET/REFRESH_TOKEN).");
    }
    return { clientId, clientSecret, refreshToken };
}

// In-process access-token cache. Zoho access tokens last ~1h; we refresh a minute
// early. Module-scoped so it survives across requests in the same server instance.
let cachedToken: { token: string; expiresAt: number } | null = null;

/** Exchange the refresh token for an access token (cached until ~1 min before expiry). */
export async function getAccessToken(): Promise<string> {
    if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.token;

    const { clientId, clientSecret, refreshToken } = requireSecrets();
    // Secrets (client_secret, refresh_token) go in the form-urlencoded body, not the
    // URL query string: query strings are routinely written to access logs / APM at
    // every TLS-terminating hop, request bodies are not. This is the OAuth2 (RFC 6749)
    // form; Zoho's token endpoint accepts it.
    const body = new URLSearchParams({
        grant_type: "refresh_token",
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
    });

    const resp = await zohoFetch(`${config.zohoAccountsUrl()}/oauth/v2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
    }, "Zoho token exchange");
    if (!resp.ok) throw new ZohoError(`Token exchange failed (${resp.status}): ${await resp.text()}`);
    const data = (await resp.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) throw new ZohoError(`Token exchange returned no access_token: ${JSON.stringify(data)}`);

    const ttlMs = (data.expires_in ?? 3600) * 1000;
    cachedToken = { token: data.access_token, expiresAt: Date.now() + ttlMs - 60_000 };
    return data.access_token;
}

/** Reset the cached token (used by tests). */
export function _resetTokenCache(): void {
    cachedToken = null;
}

function authHeader(token: string): Record<string, string> {
    return { Authorization: `Zoho-oauthtoken ${token}` };
}

export interface CreateRequestResult {
    requestId: string;
    actionId: string;
    documentId: string;
}

/**
 * Upload the agreement PDF and register the single SIGN recipient. Mirrors the
 * script's create_request: is_sequential, one SIGN action, verify_recipient false.
 */
export interface RedirectPages {
    sign_completed: string;
    sign_success: string;
    sign_declined: string;
    sign_later: string;
}

export async function createRequest(params: {
    token: string;
    pdf: Buffer;
    filename: string;
    recipientEmail: string;
    recipientName: string;
    requestName: string;
    expirationDays: number;
    redirectPages: RedirectPages;
}): Promise<CreateRequestResult> {
    const payload = {
        requests: {
            request_name: params.requestName,
            expiration_days: params.expirationDays,
            is_sequential: true,
            // Where Zoho sends the (embedded) signer when they finish. Without this
            // the embedded session ends on Zoho's own page and the applicant is
            // stranded — never returned to checkin. Set at creation, inside
            // `requests` (Zoho has no redirect param on the embedtoken call).
            redirect_pages: params.redirectPages,
            actions: [
                {
                    action_type: "SIGN",
                    recipient_email: params.recipientEmail,
                    recipient_name: params.recipientName,
                    signing_order: 0,
                    verify_recipient: false,
                    // Required for the in-app embedded signing flow: the recipient must be
                    // created as embedded, or the embedtoken call later fails with Zoho
                    // code 2009 "Action is not embedded" (the recipient defaults to
                    // email-based signing otherwise).
                    is_embedded: true,
                },
            ],
        },
    };

    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(params.pdf)], { type: "application/pdf" }), params.filename);
    form.append("data", JSON.stringify(payload));

    const resp = await zohoFetch(`${config.zohoSignApi()}/requests`, {
        method: "POST",
        headers: authHeader(params.token),
        body: form,
    }, "Zoho createRequest");
    if (!resp.ok) throw new ZohoError(`Failed to create request (${resp.status}): ${await resp.text()}`);
    const result = (await resp.json()) as {
        status?: string;
        requests?: {
            request_id?: string;
            actions?: { action_id?: string }[];
            document_ids?: { document_id?: string }[];
        };
    };
    if (result.status !== "success" || !result.requests) {
        throw new ZohoError(`Failed to create request: ${JSON.stringify(result)}`);
    }
    const req = result.requests;
    const requestId = req.request_id;
    const actionId = req.actions?.[0]?.action_id;
    const documentId = req.document_ids?.[0]?.document_id;
    if (!requestId || !actionId || !documentId) {
        throw new ZohoError(`Create request missing ids: ${JSON.stringify(result)}`);
    }
    return { requestId, actionId, documentId };
}

/**
 * Attach the agreement's signature fields and submit the request. Mirrors the
 * script's submit_request; `prefill` seeds field default_values (e.g. PrintedName).
 */
export async function submitRequest(params: {
    token: string;
    requestId: string;
    actionId: string;
    documentId: string;
    recipientEmail: string;
    recipientName: string;
    lastPageNo: number;
    pageWidth: number;
    pageHeight: number;
    prefill?: FieldPrefill;
}): Promise<void> {
    const fields = toZohoFields(params.documentId, params.lastPageNo, params.pageWidth, params.pageHeight, params.prefill);
    const payload = {
        requests: {
            actions: [
                {
                    action_id: params.actionId,
                    recipient_name: params.recipientName,
                    recipient_email: params.recipientEmail,
                    action_type: "SIGN",
                    // Re-assert embedded on submit so the field-attach step can't reset the
                    // recipient back to email signing (keeps the embedtoken call valid).
                    is_embedded: true,
                    fields,
                },
            ],
        },
    };

    const form = new FormData();
    form.append("data", JSON.stringify(payload));

    const resp = await zohoFetch(`${config.zohoSignApi()}/requests/${params.requestId}/submit`, {
        method: "POST",
        headers: authHeader(params.token),
        body: form,
    }, "Zoho submitRequest");
    if (!resp.ok) throw new ZohoError(`Failed to submit request (${resp.status}): ${await resp.text()}`);
    const result = (await resp.json()) as { status?: string };
    if (result.status !== "success") throw new ZohoError(`Failed to submit request: ${JSON.stringify(result)}`);
}

/**
 * Mint a short-lived embedded-signing URL for the recipient action so the
 * applicant can sign in-app (no email). Re-fetchable per click — the request
 * itself is created once and stored, only this session URL is ephemeral.
 *
 * `host` must be allow-listed in the Zoho Sign console for embedded signing.
 */
export async function getEmbeddedSignUrl(params: {
    token: string;
    requestId: string;
    actionId: string;
    host: string;
}): Promise<string> {
    const url = new URL(`${config.zohoSignApi()}/requests/${params.requestId}/actions/${params.actionId}/embedtoken`);
    url.searchParams.set("host", params.host);

    const resp = await zohoFetch(url, { method: "POST", headers: authHeader(params.token) }, "Zoho embedtoken");
    if (!resp.ok) throw new ZohoError(`Failed to get embed token (${resp.status}): ${await resp.text()}`);
    const result = (await resp.json()) as { status?: string; sign_url?: string; requests?: { sign_url?: string } };
    const signUrl = result.sign_url ?? result.requests?.sign_url;
    if (!signUrl) throw new ZohoError(`Embed token response missing sign_url: ${JSON.stringify(result)}`);
    return signUrl;
}

/** Request states Zoho can never collect a signature from — a fresh request is required (#876). */
const TERMINAL_REQUEST_STATUSES = new Set(["declined", "expired", "recalled", "deleted"]);

export type ZohoRequestState = "completed" | "in_progress" | "terminal";

/**
 * Read a signing request's current state, normalized to the three cases checkin
 * acts on: "completed" (record the contract signed), "terminal" (declined,
 * expired, recalled or deleted — the request is dead, a fresh one must be
 * created), and "in_progress" (anything else — still signable). Used to sync
 * state on the applicant's return from embedded signing (the inbound webhook is
 * unreliable against a scale-to-zero dev instance) and to detect dead requests
 * on the resume path.
 */
export async function getRequestStatus(token: string, requestId: string): Promise<ZohoRequestState> {
    const resp = await zohoFetch(`${config.zohoSignApi()}/requests/${requestId}`, {
        method: "GET",
        headers: authHeader(token),
    }, "Zoho getRequestStatus");
    if (!resp.ok) throw new ZohoError(`Failed to get request status (${resp.status}): ${await resp.text()}`);
    const result = (await resp.json()) as { requests?: { request_status?: string } };
    const status = result.requests?.request_status?.toLowerCase() ?? "";
    if (status === "completed") return "completed";
    return TERMINAL_REQUEST_STATUSES.has(status) ? "terminal" : "in_progress";
}

/** Recall (cancel) a sent signing request so it can no longer be signed. */
export async function recallRequest(token: string, requestId: string): Promise<void> {
    const resp = await zohoFetch(`${config.zohoSignApi()}/requests/${requestId}/recall`, {
        method: "POST",
        headers: authHeader(token),
    }, "Zoho recallRequest");
    if (!resp.ok) throw new ZohoError(`Failed to recall request (${resp.status}): ${await resp.text()}`);
    const result = (await resp.json()) as { status?: string };
    if (result.status !== "success") throw new ZohoError(`Failed to recall request: ${JSON.stringify(result)}`);
}
