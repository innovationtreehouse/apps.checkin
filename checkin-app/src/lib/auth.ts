import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth-options';
import { getKioskPublicKeys, verifyKioskSignature } from './verify-kiosk';
import { config, isStagingAccessAllowed } from './config';
import { apiError } from './api-response';
import type { AuthenticatedUser, BusinessRole, AuthResult } from '@/types/auth';

/**
 * Authenticate a request — tries kiosk signature first, then session. Resolves the
 * "raw" auth result; the ops-stg gate below is applied uniformly to whatever this
 * resolves to.
 */
async function resolveAuthResult(
    req: NextRequest,
    body?: string,
    opts?: { sessionOnly?: boolean }
): Promise<AuthResult> {
    // 1. Try kiosk signature. Skipped for session-only resolution: verifying a
    // signature consumes its single-use nonce, so a caller that discards kiosk
    // results (getOptionalSessionUser) must not verify here — the kiosk-tolerant
    // route's own verification of the same request would then see a replay.
    if (!opts?.sessionOnly) {
        const pubKeys = getKioskPublicKeys();
        const hasKioskHeaders = req.headers.get('x-kiosk-signature');

        if (pubKeys.length > 0 && hasKioskHeaders) {
            const method = req.method;
            const path = new URL(req.url).pathname;
            const result = verifyKioskSignature(
                method, path, body || '',
                req.headers.get('x-kiosk-timestamp'),
                req.headers.get('x-kiosk-signature'),
                req.headers.get('x-kiosk-nonce'),
                pubKeys
            );
            if (result.ok) return { type: 'kiosk' };
        } else if (pubKeys.length === 0 && config.isLocal()) {
            // Local laptops only (CHECKIN_ENV=local): treat as kiosk when no signing key is
            // configured, so the kiosk/check-in flows can be exercised without provisioning keys.
            // Deliberately NOT enabled on the cloud dev instance (CHECKIN_ENV=dev) — that box is
            // publicly reachable and must require a real kiosk key, exactly like prod. CHECKIN_ENV
            // is unset under tests, so this stays off there too.
            if (hasKioskHeaders || !req.headers.get('cookie')) {
                return { type: 'kiosk' };
            }
        }
    }

    // 2. Try session
    const session = await getServerSession(authOptions);
    if (session?.user) {
        // No numeric id = no live person behind the session (the jwt re-sync emptied the
        // token, or the dev guest persona). Downstream `where: { x: user.id }` filters
        // would drop an undefined id and match every row, so this must not be a session.
        if (typeof session.user.id !== 'number') {
            return { type: 'unauthenticated' };
        }
        // A denied household is locked out of the whole app. Treat it as unauthenticated
        // so every route — including authenticated-only ones — fails closed, regardless of
        // each route's role list. The jwt callback already strips role flags; this is the
        // belt-and-suspenders that also denies plain member endpoints.
        if ((session.user as AuthenticatedUser).denied) {
            return { type: 'unauthenticated' };
        }
        return { type: 'session', user: session.user as AuthenticatedUser };
    }

    return { type: 'unauthenticated' };
}

/**
 * Authenticate a request — the API trust-boundary chokepoint every `withAuth` route
 * and `security/handler.ts` route (including `authorize: 'public'`) calls through.
 *
 * ops-stg ACCESS GATE: on staging, anything that isn't a verified org member or an
 * explicitly canAccessStaging-flagged account is downgraded to `unauthenticated` here
 * — regardless of what it actually resolved to (session, kiosk, or already
 * unauthenticated). This is deliberately unconditional, not scoped to `session` results
 * only: a kiosk auth carries no org/flag claims either, so it fails the same predicate
 * and must not get a pass. Fails closed by construction — isStagingAccessAllowed
 * denies on any falsy/missing claim.
 */
export async function authenticateRequest(
    req: NextRequest,
    body?: string,
    opts?: { sessionOnly?: boolean }
): Promise<AuthResult> {
    const result = await resolveAuthResult(req, body, opts);

    if (config.isStaging()) {
        const claims = result.type === 'session' ? result.user : null;
        if (!isStagingAccessAllowed(claims)) {
            return { type: 'unauthenticated' };
        }
    }

    return result;
}

/**
 * Read the OPTIONAL web session for routes that legitimately serve anonymous
 * callers (the public program catalog, kiosk-tolerant attendance reads) and so
 * cannot use withAuth — which 401s anonymous.
 *
 * Built on authenticateRequest so there is ONE denied gate, not a parallel
 * implementation that can drift (the exact hand-rolled-denied class GAP-1 came
 * from): a denied household already resolves to `unauthenticated` in
 * authenticateRequest, so it falls through to `undefined` here → sees the
 * public-only view, same as anonymous. Kiosk requests also resolve to
 * `undefined` (this returns only real session users); a kiosk-tolerant route
 * keeps its own kiosk plumbing. Resolution is session-only: kiosk signatures
 * are NOT verified here, because verification consumes the single-use nonce
 * and would make the route's own verification of the same request fail as a
 * replay.
 *
 * Scope: this is for genuinely PUBLIC / optional-session reads only. It is NOT
 * an escape hatch for routes that should require a session — those use withAuth
 * (mandatory). Route files MUST source an optional session through this helper
 * instead of calling getServerSession directly, so the Step 7 drift-guard can
 * ban getServerSession in app/api/** outright. The session read lives here in
 * the auth boundary, alongside authenticateRequest.
 */
export async function getOptionalSessionUser(req: Request): Promise<AuthenticatedUser | undefined> {
    const auth = await authenticateRequest(req as NextRequest, undefined, { sessionOnly: true });
    return auth.type === 'session' ? auth.user : undefined;
}

/**
 * Higher-order function for route handlers with auth.
 * `roles` uses the actual Prisma business role field names — no abstract groupings.
 *
 * Example usage:
 *   export const GET = withAuth(
 *       { roles: ['isSysadmin', 'isBoardMember'] },
 *       async (req, auth) => { ... }
 *   );
 */
export function withAuth<Ctx = unknown>(
    options: {
        roles?: BusinessRole[];
        allowKiosk?: boolean;
    },
    handler: (req: NextRequest, auth: AuthResult, ctx: Ctx) => Promise<NextResponse>
) {
    // Ctx is the Next.js route-handler context ({ params }). Forwarded so dynamic
    // routes can read their params; non-dynamic handlers (and unit tests that call
    // the route with just a request) simply omit it.
    //
    // The wrapper accepts the base `Request` (not `NextRequest`): the auth
    // boundary only reads headers/url/method, all present on `Request`, and this
    // lets tests (and any non-Next caller) invoke the route with a plain
    // `new Request(...)` without casting. The Next runtime passes a NextRequest
    // (a subtype) at runtime, and the inner handler keeps its NextRequest typing.
    return async (req: Request, ctx?: Ctx) => {
        const nreq = req as NextRequest;
        const auth = await authenticateRequest(nreq);

        if (auth.type === 'unauthenticated') {
            return apiError('Unauthorized', 401);
        }

        if (auth.type === 'kiosk' && !options.allowKiosk) {
            return apiError('Forbidden', 403);
        }

        if (options.roles && auth.type === 'session') {
            const user = auth.user;
            const hasRole = options.roles.some(role => user[role] === true);
            if (!hasRole) {
                return apiError('Forbidden', 403);
            }
        }

        return handler(nreq, auth, ctx as Ctx);
    };
}
