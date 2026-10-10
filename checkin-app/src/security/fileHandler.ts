/**
 * The file-route runtime — the only legal way to ship a stored file (plan
 * rule 7: files are not JSON). The file-shaped twin of handler().
 *
 * Flow:
 *   1. Look up the defineFileRoute entry for endpointKey.
 *   2. Authenticate. Only a session with an integer person id proceeds;
 *      unauthenticated, kiosk and id-less sessions get 401 (plan rule 6).
 *   3. Build the CallerContext and run the admission gate (`authorize`).
 *   4. Pick the view: the first `orderedView` role the caller satisfies.
 *   5. Run the user fn → { row, contentType, filename? }.
 *   6. Per-row scope check: the view must cover the served field's tier on
 *      this row (the same fieldVisible/scopesHeld the stripper uses), else 404
 *      — a file the caller may not see is indistinguishable from none.
 *   7. Emit row[field] (bytes) with the headers fixed for its content type.
 *
 * Errors thrown from the user fn: `ApiResponseError` → its status; anything
 * else → opaque 500.
 *
 * IMPORTANT: This file is CODEOWNERS-gated.
 */
import type { NextRequest } from 'next/server';
import { authenticateRequest } from '@/lib/auth';
import { apiError } from '@/lib/api-response';
import {
    classifications,
    fieldVisible,
    getFileRoute,
    FILE_CONTENT_TYPES,
    type FileContentType,
    type Role,
    type Tier,
    type Token,
} from './core';
import { buildCallerContext, callerHoldsRole, resolveAccess, scopesHeld } from './access-resolvers';
import { ApiResponseError, type HandlerContext } from './handler';
// Side-effect import to register routes before fileHandler() is invoked.
import './registry';

export interface FileResult {
    /** The row holding the file: the served field plus the row's scope keys. */
    row: Record<string, unknown>;
    contentType: FileContentType;
    filename?: string;
}

export type FileHandlerFn<P = Record<string, string>> = (
    ctx: HandlerContext<P>,
) => Promise<FileResult>;

interface Delivery {
    disposition: 'inline' | 'attachment';
    sandbox: boolean;
    contentType?: string;
}
const INLINE_IMAGE: Delivery = { disposition: 'inline', sandbox: true };

// The owner-approved delivery headers per content type (1265 §3).
const DELIVERY: Record<FileContentType, Delivery> = {
    'image/jpeg': INLINE_IMAGE,
    'image/png': INLINE_IMAGE,
    'image/gif': INLINE_IMAGE,
    'image/webp': INLINE_IMAGE,
    // No sandbox: Chrome's PDF viewer refuses a sandboxed document.
    'application/pdf': { disposition: 'inline', sandbox: false },
    'text/plain': { disposition: 'attachment', sandbox: false, contentType: 'text/plain; charset=utf-8' },
};

function contentDisposition(disposition: string, filename: string | undefined): string {
    if (!filename) return disposition;
    const ascii = filename.replace(/[^A-Za-z0-9._ -]/g, '_');
    const encoded = encodeURIComponent(filename).replace(
        /['()*]/g,
        c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    );
    return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export function fileHandler<P extends Record<string, string> = Record<string, string>>(
    endpoint: string,
    fn: FileHandlerFn<P>,
) {
    return async (
        req: NextRequest,
        ctx?: { params?: Promise<P> },
    ): Promise<Response> => {
        const spec = getFileRoute(endpoint);
        if (!spec) {
            console.error(`[security] No file-route registry entry for ${endpoint}`);
            return apiError('Internal Server Error', 500);
        }

        const params = (ctx?.params ? await ctx.params : ({} as P)) ?? ({} as P);
        const auth = await authenticateRequest(req);
        if (auth.type !== 'session' || !Number.isInteger(auth.user.id)) {
            return apiError('Unauthorized', 401);
        }
        const callerCtx = await buildCallerContext(auth, spec.ctxNeeds);

        const { allowed } = await resolveAccess(spec.authorize, { auth, params, callerContext: callerCtx });
        if (!allowed) return apiError('Forbidden', 403);

        let role: Role = 'authenticated';
        let viewTokens: readonly Token[] = [];
        for (const [r, tokens] of spec.orderedView) {
            if (callerHoldsRole(r, auth, params, callerCtx)) {
                role = r;
                viewTokens = tokens;
                break;
            }
        }

        let result: FileResult;
        try {
            result = await fn({ req, auth, params, role });
        } catch (err) {
            if (err instanceof ApiResponseError) return apiError(err.message, err.status);
            console.error(`[${endpoint}] file handler error:`, err);
            return apiError('Internal Server Error', 500);
        }

        const { model, field } = spec.file;
        const tier = (classifications[model] as Record<string, Tier>)[field];
        if (!fieldVisible(tier, viewTokens, scopesHeld(model, result.row, callerCtx))) {
            return apiError('Not found', 404);
        }

        const bytes = result.row[field];
        const delivery = (FILE_CONTENT_TYPES as readonly string[]).includes(result.contentType)
            ? DELIVERY[result.contentType]
            : undefined;
        if (!(bytes instanceof Uint8Array) || !delivery) {
            console.error(`[${endpoint}] file handler returned no bytes or a disallowed content type`);
            return apiError('Internal Server Error', 500);
        }

        const headers: Record<string, string> = {
            'Content-Type': delivery.contentType ?? result.contentType,
            'Content-Disposition': contentDisposition(delivery.disposition, result.filename),
            'Content-Length': String(bytes.byteLength),
            'X-Content-Type-Options': 'nosniff',
            'Cache-Control': 'private, no-store',
        };
        if (delivery.sandbox) headers['Content-Security-Policy'] = 'sandbox';
        // Copied into an ArrayBuffer-backed view, which is what BodyInit accepts.
        return new Response(new Uint8Array(bytes), { status: 200, headers });
    };
}
