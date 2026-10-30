import { NextRequest, NextResponse } from 'next/server';
import { getToken } from 'next-auth/jwt';
import { config as appConfig, isStagingAccessAllowed, ORG_DOMAIN } from '@/lib/config';
import { bodyLimitFor, isDeclaredBodyTooLarge } from '@/lib/requestBodyLimit';

/** True when a body sent without Content-Length runs past the route's limit. Stops reading once it does. */
async function isStreamedBodyTooLarge(pathname: string, body: ReadableStream<Uint8Array>): Promise<boolean> {
    const limit = bodyLimitFor(pathname);
    const reader = body.getReader();
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) return false;
        total += value.byteLength;
        if (total > limit) {
            await reader.cancel();
            return true;
        }
    }
}

/**
 * Site-wide org-login gate for the cloud dev instance (docs/ops/dev-instance.md, "Running the
 * cloud dev instance")
 * — and the ops-stg ACCESS GATE (see docs on the staging access gate).
 *
 * When CHECKIN_ENV=dev, every page route requires a session whose Google hosted-domain (`hd`)
 * claim is the org domain and whose email is verified. Anonymous visitors and bots are bounced
 * to Google login and can read nothing else — delivering both "reachable by org members" and
 * "not world-readable".
 *
 * In `prod` and `local` the gate is inert (public surfaces stay public; local work needs no Google).
 *
 * On ops-stg (isStaging()) the predicate is the same verified-org-member check, OR'd with
 * canAccessStaging (the sysadmin-settable escape hatch). An AUTHENTICATED caller who fails it
 * is bounced to the bare /access-denied page, not /signin: ops-stg runs a scrubbed copy of
 * PRODUCTION data behind PROD's Google OAuth client, deliberately unrestricted to the org
 * workspace, so ANY Google account can complete sign-in and re-prompting login would only
 * loop a stranger through Google to the same wall. An ANONYMOUS caller still goes to /signin,
 * like the dev gate — otherwise an org member who hasn't logged in yet dead-ends on a page
 * that deliberately carries no sign-in affordance. This is only ONE of three surfaces the gate covers —
 * see isStagingAccessAllowed's callers in lib/auth.ts (authenticateRequest, the API chokepoint)
 * and security/access-resolvers.ts (resolveAccess, the `authorize: 'public'` path this
 * middleware never gates: on /api it runs only the body size check).
 */
export async function middleware(req: NextRequest) {
    // /api gets the body size check only; routes there self-enforce auth.
    const { pathname } = req.nextUrl;
    if (pathname.startsWith('/api/')) {
        const contentLength = req.headers.get('content-length');
        // A body with no declared length is counted on a clone so the route still reads the original.
        const streamedBody = contentLength === null ? req.clone().body : null;
        if (
            isDeclaredBodyTooLarge(pathname, contentLength)
            || (streamedBody !== null && await isStreamedBodyTooLarge(pathname, streamedBody))
        ) {
            return NextResponse.json({ error: 'Request body too large' }, { status: 413 });
        }
        return NextResponse.next();
    }

    // The bare "Access Denied" page must stay reachable in every env, or a denied
    // user would loop on the redirect below (and an anonymous hit just sees the words).
    if (req.nextUrl.pathname.startsWith('/access-denied')) {
        return NextResponse.next();
    }

    // Household-denial login gate — runs in ALL envs (prod included), unlike the dev org
    // gate further down. A board "Deny Membership" stamps token.denied via the jwt callback;
    // bounce every page navigation to the bare /access-denied screen. APIs self-enforce
    // (authenticateRequest treats denied sessions as unauthenticated), so they're exempt
    // via the matcher and don't need handling here.
    const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
    if (token?.denied) {
        return NextResponse.redirect(new URL('/access-denied', req.url));
    }

    if (appConfig.isStaging()) {
        // getToken() decodes the cookie without the jwt callback, so these claims can be stale;
        // see "Accepted risks" in docs/security/SECURITY-POLICY.md.
        if (isStagingAccessAllowed(token)) {
            return NextResponse.next();
        }
        // Split by AUTHENTICATION, not authorization. An anonymous caller gets the
        // login screen exactly like the dev gate below: /access-denied is by product
        // decision a bare wall with no sign-in affordance (it is also the DENIED-
        // household landing screen, which must not offer one), so an org member who
        // simply hasn't logged in yet would otherwise dead-end there with no way
        // forward but hand-typing /signin.
        //
        // Safe because signing in grants nothing by itself: the same
        // isStagingAccessAllowed predicate re-runs on the way back, so a stranger who
        // completes Google login lands on /access-denied then — with a token, so this
        // branch doesn't retry and there is no loop.
        if (!token) {
            const signInUrl = new URL('/signin', req.url);
            signInUrl.searchParams.set('callbackUrl', req.nextUrl.pathname + req.nextUrl.search);
            return NextResponse.redirect(signInUrl);
        }
        return NextResponse.redirect(new URL('/access-denied', req.url));
    }

    if (appConfig.checkinEnv() !== 'dev') {
        return NextResponse.next();
    }

    const isVerifiedOrgMember = token?.hd === ORG_DOMAIN && token?.emailVerified === true;
    if (isVerifiedOrgMember) {
        return NextResponse.next();
    }

    const signInUrl = new URL('/signin', req.url);
    signInUrl.searchParams.set('callbackUrl', req.nextUrl.pathname + req.nextUrl.search);
    return NextResponse.redirect(signInUrl);
}

export const config = {
    // Gate page navigation. /api is matched separately and gets only the body size check —
    // routes self-enforce auth (withAuth / kiosk signature), which also lets a keyed kiosk reach
    // /api/scan on dev, keeps NextAuth's own sign-in + Google callback reachable, and avoids
    // redirecting JSON clients to HTML. The page matcher exempts:
    //  - signin      — the custom sign-in screen itself, or anonymous visitors would loop forever.
    //  - _next/*, favicon — framework internals.
    //  - any path with a file extension (`.*\..*`) — public static assets under /public (the brand
    //    logo/mark, svgs). They must stay reachable on the dev instance, and
    //    next/image optimizes via an origin fetch of its source — so a gated /brand/*.webp source
    //    makes /_next/image return 400 (the broken dev-instance logo).
    matcher: ['/((?!api|signin|_next/static|_next/image|favicon.ico|.*\\..*).*)', '/api/(.*)'],
};
