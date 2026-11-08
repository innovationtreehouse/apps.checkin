/**
 * The handler runtime — the only legal way to ship an API response.
 *
 * Flow:
 *   1. Look up the registry entry for endpointKey.
 *   2. Authenticate the request + build the per-request CallerContext. The
 *      prefetch is scoped to spec.ctxNeeds (derived from the route's grants
 *      at registration) — a route whose policy never consults program or
 *      visitor scopes pays zero context queries.
 *   3. Run the admission gate (`authorize`). 401/403 if it fails.
 *   4. Walk `orderedView` top-to-bottom; pick the first role the caller
 *      satisfies. Its tokens become the view.
 *   5. Run the user fn → ModelBag.
 *   6. Recursively strip the bag via stripBag(): for each row, compute its
 *      scopes vs the caller, then per field check `fieldVisible(tier,
 *      tokens, scopes)`. The stripper lives in ./stripper so it can be
 *      unit-tested in isolation.
 *   7. On a GET, when the stripped bag carries a marked field on a row that is
 *      not the caller's own, record the view (./financeView). A failed write is
 *      an opaque 500: fail closed.
 *   8. Wrap in envelope, emit.
 *
 * Errors thrown from the user fn are caught:
 *   - `ApiResponseError` → mapped to its declared status, message, optional code & field names.
 *   - any other error    → opaque 500, so its message never reaches the client.
 *
 * IMPORTANT: This file is CODEOWNERS-gated.
 */
import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest } from '@/lib/auth';
import { apiError } from '@/lib/api-response';
import type { AuthResult } from '@/types/auth';
import { getRoute, type Role, type Token } from './core';
import { buildCallerContext, callerHoldsRole, resolveAccess } from './access-resolvers';
import { stripBag } from './stripper';
import { pageViewFoldErrors, recordView, viewedRecords } from './financeView';
// Side-effect import to register routes/outbounds before handler() is invoked.
import './registry';

const foldErrors = pageViewFoldErrors();
if (foldErrors.length > 0) throw new Error(`Bad page-view allowlist:\n  ${foldErrors.join('\n  ')}`);

export class ApiResponseError extends Error {
    constructor(
        public readonly status: number,
        message: string,
        public readonly code?: string,
        /** Names of the refused inputs, never their submitted values. */
        public readonly fields?: readonly string[],
    ) {
        super(message);
        this.name = 'ApiResponseError';
    }
}

/** The error body: `{ error }`, plus `code` and `fields` only when the thrower set them. */
export function renderApiResponseError(err: ApiResponseError): NextResponse {
    const hasFields = Boolean(err.fields?.length);
    if (err.code === undefined && !hasFields) return apiError(err.message, err.status);
    return NextResponse.json(
        {
            error: err.message,
            ...(err.code === undefined ? {} : { code: err.code }),
            ...(hasFields ? { fields: err.fields } : {}),
        },
        { status: err.status },
    );
}

export const notFound = (message = 'Not found') => new ApiResponseError(404, message);
export const forbidden = (message = 'Forbidden') => new ApiResponseError(403, message);
export const badRequest = (message = 'Bad request') => new ApiResponseError(400, message);
export const unauthorized = (message = 'Unauthorized') => new ApiResponseError(401, message);

export interface HandlerContext<P = Record<string, string>> {
    req: NextRequest;
    auth: AuthResult;
    params: P;
    role: Role;
}

export type ModelBag = Record<string, unknown>;
export type HandlerFn<P = Record<string, string>> = (
    ctx: HandlerContext<P>,
) => Promise<ModelBag>;

export function handler<P extends Record<string, string> = Record<string, string>>(
    endpoint: string,
    fn: HandlerFn<P>,
) {
    return async (
        req: NextRequest,
        ctx?: { params?: Promise<P> },
    ): Promise<NextResponse> => {
        const spec = getRoute(endpoint);
        if (!spec) {
            console.error(`[security] No registry entry for ${endpoint}`);
            return apiError('Internal Server Error', 500);
        }

        const params = (ctx?.params ? await ctx.params : ({} as P)) ?? ({} as P);
        const { allowJoinPending } = spec;
        const auth = await authenticateRequest(req, undefined, { allowJoinPending });
        const callerCtx = await buildCallerContext(auth, spec.ctxNeeds);

        const { allowed } = await resolveAccess(spec.authorize, {
            auth,
            params,
            callerContext: callerCtx,
            authorization: req.headers.get('authorization'),
            allowJoinPending,
        });
        if (!allowed) {
            return apiError(
                auth.type === 'unauthenticated' ? 'Unauthorized' : 'Forbidden',
                auth.type === 'unauthenticated' ? 401 : 403,
            );
        }

        let chosenRole: Role | undefined;
        let viewTokens: readonly Token[] = [];
        for (const [role, tokens] of spec.orderedView) {
            if (callerHoldsRole(role, auth, params, callerCtx, { allowJoinPending })) {
                chosenRole = role;
                viewTokens = tokens;
                break;
            }
        }
        if (!chosenRole) {
            // No matching role → empty view. Caller is admitted (authorize
            // passed) but the policy grants them nothing. Fall through with
            // an empty token list; everything will be stripped.
            chosenRole = auth.type === 'unauthenticated' ? 'unauthenticated' : 'authenticated';
        }

        let bag: ModelBag;
        try {
            bag = await fn({ req, auth, params, role: chosenRole });
        } catch (err) {
            if (err instanceof ApiResponseError) return renderApiResponseError(err);
            console.error(`[${endpoint}] handler error:`, err);
            return apiError('Internal Server Error', 500);
        }

        const stripped = stripBag(bag, viewTokens, callerCtx);

        if (endpoint.startsWith('GET ')) {
            const records = viewedRecords(stripped, spec.financeView, callerCtx, params);
            if (
                records.length > 0 &&
                !(await recordView({ endpoint, req, auth, role: chosenRole, records, spec: spec.financeView }))
            ) {
                return apiError('Internal Server Error', 500);
            }
        }

        let body: unknown;
        if (spec.envelope === null) {
            const keys = Object.keys(stripped);
            body = keys.length === 1 ? stripped[keys[0]] : stripped;
        } else {
            const keys = Object.keys(stripped);
            const payload = keys.length === 1 ? stripped[keys[0]] : stripped;
            body = { [spec.envelope]: payload };
        }
        return NextResponse.json(body, { status: 200 });
    };
}
